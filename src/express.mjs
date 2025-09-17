import express from "express";
import helmet from "helmet";
import { nanoid } from "nanoid";
import cookieParser from "cookie-parser";
import xss from "xss";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";

import { sanitizeName } from "./profanity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 80,
  AWS_REGION = "eu-central-1",
  DDB_TABLE = "ClickRaceData",
  RACE_DURATION_SECONDS = 10,
  ADMIN_TOKEN = ""
} = process.env;

const RACE_DURATION = Math.max(1, Number(RACE_DURATION_SECONDS) || 10);

const app = express();
app.use(cookieParser());

app.disable("x-powered-by");

app.use((req, res, next) => {
  if (req.cookies?.banned === "true" && !req.path.startsWith("/denied")) {
    return res.redirect("/denied");
  }
  next();
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "8kb" }));

const clients = new Map();
const activePlayers = new Map();
const lobbyPlayers = new Map();
const bannedIps = new Set();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/getAttendees", (req, res) => {
  const attendees = [...lobbyPlayers.values()];
  res.send(attendees);
});

function blockUser(userId) {
  for (const [ws, meta] of clients.entries()) {
    if (meta.userId === userId) {
      if (meta.ip) {
        bannedIps.add(meta.ip);
      }
      activePlayers.delete(ws);
      lobbyPlayers.delete(ws);
      clients.delete(ws);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "banned" }));
        ws.close(4403, "Banned");
      }
      broadcastLobby();
      broadcastLeaderboard();
      broadcastActiveSessions();
      break;
    }
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "Admin token not configured" });
  }
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

app.post("/api/ban/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  blockUser(id);
  res.json({ ok: true });
});

app.get("/ban", (req, res) => {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("banned", "true", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 1000 * 60 * 60 * 24
  });
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
let statsHidden = false;
let hideStatsTimeout = null;

function hasBannedCookie(cookieHeader = "") {
  return /(?:^|;\s*)banned=true(?:;|$)/i.test(cookieHeader);
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function clearHideStatsTimer() {
  if (hideStatsTimeout) {
    clearTimeout(hideStatsTimeout);
    hideStatsTimeout = null;
  }
}

function setStatsHidden(hidden) {
  if (statsHidden === hidden) return;
  statsHidden = hidden;
  broadcastLeaderboard();
}

function scheduleStatsHide() {
  clearHideStatsTimer();
  if (!nextRaceStartAt) {
    setStatsHidden(false);
    return;
  }
  const hideDelay = nextRaceStartAt - Date.now() - 5000;
  if (hideDelay <= 0) {
    setStatsHidden(true);
    return;
  }
  setStatsHidden(false);
  hideStatsTimeout = setTimeout(() => {
    hideStatsTimeout = null;
    setStatsHidden(true);
  }, hideDelay);
}

function getLeaderboardData() {
  const endsInMs = Math.max(0, raceEndsAt - Date.now());
  const top = statsHidden
    ? []
    : [...activePlayers.values()]
        .map(p => ({ userId: p.userId, name: p.name, score: p.score }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.userId.localeCompare(b.userId);
        })
        .slice(0, 20);
  return {
    raceId,
    running,
    endsInMs,
    duration: RACE_DURATION,
    top,
    hidden: statsHidden
  };
}

function sendLobbySnapshot(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "lobby_update",
    data: {
      startsAt: nextRaceStartAt,
      attendees: [...lobbyPlayers.values()]
    }
  }));
}

function sendLeaderboard(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "leaderboard", data: getLeaderboardData() }));
}

function broadcastLobby() {
  broadcast("lobby_update", {
    startsAt: nextRaceStartAt,
    attendees: [...lobbyPlayers.values()]
  });
}

function broadcastLeaderboard() {
  broadcast("leaderboard", getLeaderboardData());
}

function scheduleRaceIfNeeded() {
  if (running || lobbyPlayers.size === 0) return;
  if (!nextRaceStartAt) {
    nextRaceStartAt = Date.now() + 30_000;
    raceTimer = setInterval(checkRaceStart, 1000);
    scheduleStatsHide();
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
      clearHideStatsTimer();
      setStatsHidden(false);
      broadcastLobby();
    }
  } else {
    broadcastLobby();
  }
}

function startRace() {
  running = true;
  raceId = nanoid(8);
  raceEndsAt = Date.now() + RACE_DURATION * 1000;

  activePlayers.clear();
  lobbyPlayers.forEach((lp, ws) => {
    activePlayers.set(ws, { ...lp, score: 0, lastClickTs: 0 });
  });
  lobbyPlayers.clear();

  nextRaceStartAt = null;
  if (raceTimer) {
    clearInterval(raceTimer);
    raceTimer = null;
  }
  clearHideStatsTimer();
  setStatsHidden(false);

  broadcastLobby();
  broadcast("race_started", { raceId, endsAt: raceEndsAt });
  broadcastLeaderboard();
  setTimeout(endRace, RACE_DURATION * 1000);
}

async function updateGlobalLeaderboard(results, finishedAt, currentRaceId) {
  if (!results.length) return;
  const key = { raceId: "leaderboard", playerId: "global" };
  const existing = await ddb.send(new GetCommand({ TableName: DDB_TABLE, Key: key }));
  const existingTop = Array.isArray(existing.Item?.top) ? existing.Item.top : [];
  const newEntries = results.map(p => ({
    raceId: currentRaceId,
    playerId: `player#${p.userId}`,
    name: p.name,
    score: p.score,
    finishedAt
  }));
  const combined = [...existingTop, ...newEntries]
    .filter(item => item && typeof item === "object");
  combined.sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    if (diff !== 0) return diff;
    return (a.finishedAt || 0) - (b.finishedAt || 0);
  });
  const seen = new Set();
  const limited = [];
  for (const entry of combined) {
    const dedupeKey = `${entry.raceId}#${entry.playerId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    limited.push(entry);
    if (limited.length >= 100) break;
  }
  await ddb.send(new PutCommand({
    TableName: DDB_TABLE,
    Item: { ...key, top: limited }
  }));
}

async function endRace() {
  running = false;
  clearHideStatsTimer();
  setStatsHidden(false);
  broadcast("race_ended", { raceId });
  broadcastLeaderboard();

  const finishedAt = Date.now();
  const currentRaceId = raceId;
  const results = [...activePlayers.values()];
  if (results.length) {
    try {
      const items = results.map(p => ({
        PutRequest: {
          Item: {
            raceId: `${currentRaceId}`,
            playerId: `player#${p.userId}`,
            name: p.name,
            score: p.score,
            finishedAt
          }
        }
      }));
      for (let i = 0; i < items.length; i += 25) {
        await ddb.send(new BatchWriteCommand({
          RequestItems: { [DDB_TABLE]: items.slice(i, i + 25) }
        }));
      }
      await updateGlobalLeaderboard(results, finishedAt, currentRaceId);
    } catch (err) {
      console.error("Failed to persist race results", err);
    }
  }

  activePlayers.clear();
  raceId = null;
  raceEndsAt = 0;
  nextRaceStartAt = null;
  if (raceTimer) {
    clearInterval(raceTimer);
    raceTimer = null;
  }
  broadcastLobby();
}

function sendInitialState(ws) {
  sendLobbySnapshot(ws);
  sendLeaderboard(ws);
  if (running) {
    ws.send(JSON.stringify({ type: "race_started", data: { raceId, endsAt: raceEndsAt } }));
  }
}

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const { host } = new URL(origin);
      if (host !== req.headers.host) {
        ws.close(1008, "Forbidden origin");
        return;
      }
    } catch {
      ws.close(1008, "Forbidden origin");
      return;
    }
  }

  if (hasBannedCookie(req.headers.cookie)) {
    ws.close(4403, "Banned");
    return;
  }

  const ip = req.socket?.remoteAddress;
  if (ip && bannedIps.has(ip)) {
    ws.close(4403, "Banned");
    return;
  }

  const userId = `u_${nanoid(6)}`;
  clients.set(ws, { userId, name: null, ip });

  sendInitialState(ws);
  broadcastActiveSessions();

  ws.on("message", msg => {
    if (typeof msg !== "string" && !Buffer.isBuffer(msg)) return;
    const raw = typeof msg === "string" ? msg : msg.toString("utf8");
    if (raw.length > 1024) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const { type, data } = payload || {};
    const meta = clients.get(ws);
    if (!meta) return;

    if (type === "set_name") {
      if (running) {
        return ws.send(JSON.stringify({
          type: "error",
          data: "Rennen läuft aktuell. Bitte warte auf die nächste Runde."
        }));
      }
      const clean = sanitizeName(String(data ?? ""));
      if (!clean || !clean.trim()) {
        return ws.send(JSON.stringify({ type: "error", data: "Invalid name" }));
      }
      const safe = xss(clean);
      const normalized = safe.toLowerCase();
      const taken = [...lobbyPlayers.values(), ...activePlayers.values()].some(
        p => p.name && p.name.toLowerCase() === normalized
      );
      if (taken) {
        return ws.send(JSON.stringify({ type: "error", data: "Name already taken" }));
      }
      meta.name = safe;
      lobbyPlayers.set(ws, { userId: meta.userId, name: meta.name });
      ws.send(JSON.stringify({ type: "name_ok", data: meta.name }));
      broadcastLobby();
      scheduleRaceIfNeeded();
    }

    if (type === "click" && running) {
      const participant = activePlayers.get(ws);
      if (!participant) return;
      const now = Date.now();
      if (participant.lastClickTs && now - participant.lastClickTs < 20) return;
      participant.lastClickTs = now;
      participant.score += 1;
      broadcastLeaderboard();
    }
  });

  ws.on("close", () => {
    lobbyPlayers.delete(ws);
    activePlayers.delete(ws);
    clients.delete(ws);
    broadcastLobby();
    broadcastLeaderboard();
    broadcastActiveSessions();
  });
});

app.get("/api/race/:raceId/top", async (req, res) => {
  try {
    const q = await ddb.send(new QueryCommand({
      TableName: DDB_TABLE,
      KeyConditionExpression: "raceId = :r AND begins_with(playerId, :p)",
      ExpressionAttributeValues: { ":r": `${req.params.raceId}`, ":p": "player#" },
      Limit: 20
    }));
    res.json({ raceId: req.params.raceId, top: q.Items || [] });
  } catch (err) {
    console.error("Failed to load race leaderboard", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    const key = { raceId: "leaderboard", playerId: "global" };
    const result = await ddb.send(new GetCommand({ TableName: DDB_TABLE, Key: key }));
    const top = Array.isArray(result.Item?.top) ? result.Item.top.slice(0, 20) : [];
    res.json({ top });
  } catch (err) {
    console.error("Failed to load global leaderboard", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});
