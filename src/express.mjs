import express from "express";
import helmet from "helmet";
import { nanoid } from "nanoid";
import cookieParser from "cookie-parser";
import xss from "xss";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { sanitizeName } from "./profanity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  AWS_REGION = "us-east-1",
  DDB_TABLE = "ClickRaceData",
  RACE_DURATION_SECONDS = 10
} = process.env;

const app = express();
app.use(cookieParser());

app.use((req, res, next) => {
  if (req.cookies?.banned === "true" && !req.path.startsWith("/denied")) {
    return res.redirect("/denied");
  }
  next();
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

let players = new Map();
let lobbyPlayers = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/getAttendees", (req, res) => {
  const attendees = [...lobbyPlayers.values()];
  res.send(attendees);
});

function blockUser(userId) {
  const target = [...players.entries(), ...lobbyPlayers.entries()]
    .find(([ws, p]) => p.userId === userId);

  if (target) {
    const [ws] = target;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "banned" }));
    }
    players.delete(ws);
    lobbyPlayers.delete(ws);
    broadcastLobby();
    broadcastLeaderboard();
  }
}

app.post("/api/ban/:id", (req, res) => {
  const { id } = req.params;
  blockUser(id);
  res.json({ ok: true });
});

app.get("/ban", (req, res) => {
  res.cookie("banned", "true", { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 });
  res.redirect("/denied");
});

const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
const wss = new WebSocketServer({ server });

function broadcastActiveSessions() {
  const msg = JSON.stringify({ type: "active_sessions", data: wss.clients.size });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));

let raceId = null;
let raceEndsAt = 0;
let running = false;
let nextRaceStartAt = null;
let raceTimer = null;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  [...players.keys(), ...lobbyPlayers.keys()].forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
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
    PutRequest: {
      Item: {
        raceId: `${raceId}`,
        playerId: `player#${p.userId}`,
        name: p.name,
        score: p.score,
        finishedAt,
        negScore: -p.score
      }
    }
  }));
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [DDB_TABLE]: items.slice(i, i + 25) } }));
  }

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
        if (!clean || !clean.trim()) {
          return ws.send(JSON.stringify({ type: "error", data: "Invalid name" }));
        }
        const safe = xss(clean);
        const normalized = safe.toLowerCase();
        const taken = [...players.values(), ...lobbyPlayers.values()].some(
          p => p.name && p.name.toLowerCase() === normalized
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
    TableName: DDB_TABLE,
    KeyConditionExpression: "raceId = :r AND begins_with(playerId, :p)",
    ExpressionAttributeValues: { ":r": `${req.params.raceId}`, ":p": "player#" },
    Limit: 20
  }));
  res.json({ raceId: req.params.raceId, top: q.Items || [] });
});

app.get("/api/leaderboard", async (req, res) => {
  const scan = await ddb.send(new ScanCommand({ TableName: DDB_TABLE }));
  const items = scan.Items?.filter(i => i.playerId.startsWith("player#")) || [];
  const top = items.sort((a, b) => b.score - a.score).slice(0, 20);
  res.json({ top });
});
