const ws = new WebSocket(`ws://${location.host}`);

const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const nameStatus = document.getElementById("nameStatus");
const clickBtn = document.getElementById("clickBtn");
const timerEl = document.getElementById("timer");
const boardEl = document.getElementById("board");
const lobbyDiv = document.getElementById("lobbyAttendees");
const gameEl = document.getElementById("game");
const qrEl = document.getElementById("qrcode");
const activeSessionsEl = document.getElementById("activeSessions");

let running = false;
let endsAt = 0;

function renderQr() {
  if (!qrEl || !window.QRCode) return;
  const canvas = document.createElement("canvas");
  QRCode.toCanvas(canvas, window.location.href, { width: 128 }, () => {});
  qrEl.innerHTML = "";
  qrEl.appendChild(canvas);
}
renderQr();

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderBoard(top) {
  boardEl.innerHTML = top.map((p,i)=>
    `<div class="flex justify-between px-4 py-2 bg-slate-900"><span>${i+1}. ${escapeHtml(p.name||"Player")}</span><span>${p.score}</span></div>`
  ).join("");
  if (top.length === 0) {
    boardEl.innerHTML = '<div class="px-4 py-6 text-slate-500 text-center bg-slate-900">No players yet.</div>';
  }
}

function updateTimer() {
  if (!running) {
    gameEl.classList.add("hidden");
    return;
  }
  const ms = Math.max(0, endsAt - Date.now());
  if (ms <= 0) {
    running = false;
    timerEl.textContent = "Race ended!";
    gameEl.classList.add("hidden");
    return;
  }
  timerEl.textContent = `Time left: ${(ms/1000).toFixed(1)}s`;
  gameEl.classList.remove("hidden");
  requestAnimationFrame(updateTimer);
}

ws.onmessage = e => {
  const { type, data } = JSON.parse(e.data);
  if (type === "name_ok") {
    nameStatus.textContent = `Name set: ${data}`;
    nameStatus.className = "text-sm text-emerald-400";
  }
  if (type === "error") {
    nameStatus.textContent = data;
    nameStatus.className = "text-sm text-rose-400";
  }
  if (type === "active_sessions") {
    activeSessionsEl.textContent = `Active sessions: ${data}`;
  }
  if (type === "lobby_update") {
    if (data.startsAt) {
      const ms = Math.max(0, data.startsAt - Date.now());
      timerEl.textContent = `Next race in ${(ms/1000).toFixed(0)}s`;
    } else {
      timerEl.textContent = "Waiting for players...";
    }
    lobbyDiv.innerHTML = data.attendees.map(p=>`<div class="px-3 py-1 bg-slate-800 rounded">${escapeHtml(p.name)}</div>`).join("");
  }
  if (type === "race_started") {
    running = true;
    endsAt = data.endsAt;
    updateTimer();
  }
  if (type === "race_ended") {
    running = false;
    timerEl.textContent = "Race ended!";
    gameEl.classList.add("hidden");
  }
  if (type === "leaderboard") {
    running = data.running;
    endsAt = Date.now() + data.endsInMs;
    renderBoard(data.top);
    if (running) updateTimer();
  }
};

setNameBtn.onclick = () => {
  ws.send(JSON.stringify({ type: "set_name", data: nameInput.value }));
};

clickBtn.onclick = () => {
  if (running) ws.send(JSON.stringify({ type: "click" }));
};
