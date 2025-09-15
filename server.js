import express from "express";
import helmet from "helmet";
import { nanoid } from "nanoid";
import xss from "xss";
import { WebSocketServer } from "ws";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { sanitizeName } from "./profanity.js";

const {
  PORT = 3000,
  AWS_REGION = "us-east-1",
  DDB_TABLE_SCORES = "ClickRaceScores",
  DDB_TABLE_EVENTS = "ClickRaceEvents",
  RACE_DURATION_SECONDS = 10
} = process.env;

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static("public"));

const server = app.listen(PORT, () => console.log(`Click Race running on :${PORT}`));
const wss = new WebSocketServer({ server });

function broadcastActiveSessions() {
  const msg = JSON.stringify({ type: "active_sessions", data: wss.clients.size });
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

let raceId = null;
let raceEndsAt = 0;
let running = false;

let players = new Map();
let lobbyPlayers = new Map();
let nextRaceStartAt = null;
let raceTimer = null;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  [...players.keys(), ...lobbyPlayers.keys()].forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

function broadcastLobby() {
  broadcast("lobby_update", {
    startsAt: nextRaceStartAt,
    attendees: [...lobbyPlayers.values()]
  });
}

function broadcastLeaderboard() {
  const top = [...players.values()].sort((a, b) => b.score - a.score).slice(0, 20);
  broadcast("leaderboard", {
    raceId,
    running,
    endsInMs: Math.max(0, raceEndsAt - Date.now()),
    duration: RACE_DURATION_SECONDS,
    top
  });
}

async function logEvent(type, payload) {
  await ddb.send(new PutCommand({
    TableName: DDB_TABLE_EVENTS,
    Item: { pk: `race#${raceId || "none"}`, ts: Date.now(), type, payload }
  }));
}

function scheduleRaceIfNeeded() {
  if (!nextRaceStartAt && lobbyPlayers.size > 0) {
    nextRaceStartAt = Date.now() + 30_000;
    raceTimer = setInterval(checkRaceStart, 1000);
  }
}

function checkRaceStart() {
  if (!nextRaceStartAt) return;
  const now = Date.now();
  if (now >= nextRaceStartAt) {
    if (lobbyPlayers.size > 0) {
      startRace();
    } else {
      nextRaceStartAt = null;
      clearInterval(raceTimer);
      raceTimer = null;
      broadcastLobby();
    }
  } else {
    broadcastLobby();
  }
}

function startRace() {
  running = true;
  raceId = nanoid(8);
  raceEndsAt = Date.now() + RACE_DURATION_SECONDS * 1000;

  players.clear();
  lobbyPlayers.forEach((lp, ws) => {
    players.set(ws, { ...lp, score: 0, lastClickTs: 0 });
  });
  lobbyPlayers.clear();

  broadcast("race_started", { raceId, endsAt: raceEndsAt });
  broadcastLeaderboard();
  setTimeout(endRace, RACE_DURATION_SECONDS * 1000);
}

async function endRace() {
  running = false;
  broadcast("race_ended", { raceId });
  broadcastLeaderboard();

  const finishedAt = Date.now();
  const items = [...players.values()].map(p => ({
    PutRequest: { Item: { raceId, negScore: -p.score, userId: p.userId, name: p.name, score: p.score, finishedAt } }
  }));
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [DDB_TABLE_SCORES]: items.slice(i, i + 25) } }));
  }
  await logEvent("race_ended", { raceId });

  players.clear();
  raceId = null;
  raceEndsAt = 0;
  nextRaceStartAt = null;
  clearInterval(raceTimer);
  raceTimer = null;
  broadcastLobby();
}

wss.on("connection", ws => {
  const userId = `u_${nanoid(6)}`;
  players.set(ws, { userId, name: null, score: 0, lastClickTs: 0 });

  broadcastActiveSessions();

  ws.on("message", msg => {
    try {
      const { type, data } = JSON.parse(msg);
      if (type === "set_name") {
        const clean = sanitizeName(String(data));
        if (!clean) return ws.send(JSON.stringify({ type: "error", data: "Invalid name" }));
        const safe = xss(clean);
        const normalized = safe.toLowerCase();
        const taken = [...players.values(), ...lobbyPlayers.values()].some(p =>
          p.name && p.name.toLowerCase() === normalized
        );
        if (taken) return ws.send(JSON.stringify({ type: "error", data: "Name already taken" }));
        const p = players.get(ws);
        p.name = safe;
        lobbyPlayers.set(ws, { userId: p.userId, name: p.name });
        ws.send(JSON.stringify({ type: "name_ok", data: p.name }));
        broadcastLobby();
        scheduleRaceIfNeeded();
      }
      if (type === "click" && running) {
        const p = players.get(ws);
        if (!p) return;
        const now = Date.now();
        if (p.lastClickTs && now - p.lastClickTs < 20) return;
        p.lastClickTs = now;
        p.score += 1;
        broadcastLeaderboard();
      }
    } catch {}
  });

  ws.on("close", () => {
    players.delete(ws);
    lobbyPlayers.delete(ws);
    broadcastLobby();
    broadcastLeaderboard();
    broadcastActiveSessions();
  });
});

app.get("/api/race/:raceId/top", async (req, res) => {
  const q = await ddb.send(new QueryCommand({
    TableName: DDB_TABLE_SCORES,
    KeyConditionExpression: "raceId = :r",
    ExpressionAttributeValues: { ":r": req.params.raceId },
    Limit: 20
  }));
  res.json({ raceId: req.params.raceId, top: q.Items || [] });
});

app.get("/api/leaderboard", async (req, res) => {
  const scan = await ddb.send(new ScanCommand({ TableName: DDB_TABLE_SCORES }));
  const items = scan.Items || [];
  const top = items.sort((a, b) => b.score - a.score).slice(0, 20);
  res.json({ top });
});
