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
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

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
let lastLeaderboardSnapshot = null;

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

function computeLeaderboardTop() {
  return [...activePlayers.values()]
    .map(p => ({ userId: p.userId, name: p.name, score: p.score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.userId.localeCompare(b.userId);
    })
    .slice(0, 20);
}

function calculateClicksPerSecond(score) {
  if (!Number.isFinite(score)) return 0;
  const duration = RACE_DURATION > 0 ? RACE_DURATION : 1;
  return Math.round((score / duration) * 1000) / 1000;
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
  const endsInMs = running ? Math.max(0, raceEndsAt - Date.now()) : 0;
  let top = [];

  if (!statsHidden) {
    if (running) {
      top = computeLeaderboardTop();
    } else if (lastLeaderboardSnapshot) {
      top = lastLeaderboardSnapshot.top;
    }
  }

  const currentRaceId = running
    ? raceId
    : lastLeaderboardSnapshot?.raceId ?? raceId;

  return {
    raceId: currentRaceId,
    running,
    endsInMs,
    duration: lastLeaderboardSnapshot?.duration ?? RACE_DURATION,
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
  lastLeaderboardSnapshot = null;
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

async function persistRaceResults(results, finishedAt, currentRaceId) {
  if (!results.length) return;
  const putRequests = results
    .filter(p => Number.isFinite(p.score))
    .map(p => ({
      PutRequest: {
        Item: {
          resultId: uuidv4(),
          pk: "GLOBAL", // <-- add global PK for leaderboard GSI
          score: p.score,
          userId: p.userId,
          username:
            typeof p.name === "string" && p.name.trim().length > 0 ? p.name : "Player",
          raceId: currentRaceId,
          clicksPerSecond: calculateClicksPerSecond(p.score),
          finishedAt
        }
      }
    }));

  if (!putRequests.length) return;

  for (let i = 0; i < putRequests.length; i += 25) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [DDB_TABLE]: putRequests.slice(i, i + 25) }
    }));
  }
}

async function endRace() {
  running = false;
  clearHideStatsTimer();
  const finalTop = computeLeaderboardTop();
  if (finalTop.length) {
    lastLeaderboardSnapshot = {
      raceId,
      duration: RACE_DURATION,
      top: finalTop
    };
  } else {
    lastLeaderboardSnapshot = null;
  }
  setStatsHidden(false);
  broadcast("race_ended", { raceId });
  broadcastLeaderboard();

  const finishedAt = Date.now();
  const currentRaceId = raceId;
  const results = [...activePlayers.values()];
  if (results.length) {
    try {
      await persistRaceResults(results, finishedAt, currentRaceId);
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

async function fetchTopResults({ limit = 20 } = {}) {
  const sanitizedLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(100, Math.floor(limit))
    : 20;

  const res = await ddb.send(new QueryCommand({
    TableName: DDB_TABLE,
    IndexName: "GlobalLeaderboard", // <-- use GSI
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": "GLOBAL" },
    ScanIndexForward: false,
    Limit: sanitizedLimit
  }));

  return res.Items ?? [];
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

app.get("/api/leaderboard", async (req, res) => {
  try {
    const top = await fetchTopResults({ limit: 20 });
    res.json({ top });
  } catch (err) {
    console.error("Failed to load global leaderboard", err);
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});
