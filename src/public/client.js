const ws = new WebSocket(`ws://${location.host}`);

const nameInput = document.getElementById("nameInput");
const setNameBtn = document.getElementById("setNameBtn");
const nameStatus = document.getElementById("nameStatus");
const nameForm = document.getElementById("nameForm");
const clickBtn = document.getElementById("clickBtn");
const timerEl = document.getElementById("timer");
const boardEl = document.getElementById("board");
const lobbyDiv = document.getElementById("lobbyAttendees");
const gameEl = document.getElementById("game");
const qrEl = document.getElementById("qrcode");
const showQrBtn = document.getElementById("showQrBtn");
const qrModal = document.getElementById("qrModal");
const activeSessionsCountEl = document.getElementById("activeSessionsCount");

const RACE_DURATION_SECONDS = 10;

let running = false;
let endsAt = 0;

function renderQr() {
  if (!qrEl || !window.QRCode) return;
  const canvas = document.createElement("canvas");
  QRCode.toCanvas(canvas, window.location.href, { width: 256 }, () => {});
  qrEl.innerHTML = "";
  qrEl.appendChild(canvas);
}

if (showQrBtn && qrModal) {
  showQrBtn.onclick = () => {
    qrModal.classList.remove("hidden");
    renderQr();
  };
  qrModal.onclick = () => {
    qrModal.classList.add("hidden");
    qrEl.innerHTML = "";
  };
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderBoard(top, duration) {
  boardEl.innerHTML = top.map((p,i)=>{
    const pct = Math.min(p.score, 100);
    const elapsed = running ? Math.max(0, (duration * 1000 - (endsAt - Date.now()))/1000) : duration;
    const cps = elapsed > 0 ? (p.score / elapsed).toFixed(2) : "0.00";
    return `<div class="px-4 py-2 bg-slate-900">
      <div class="flex justify-between text-sm sm:text-base"><span>${i+1}. ${escapeHtml(p.name||"Player")}</span><span>${p.score} (${cps}/s)</span></div>
      <div class="w-full bg-slate-800 rounded h-2 mt-1">
        <div class="bg-emerald-500 h-2 rounded" style="width:${pct}%"></div>
      </div>
    </div>`;
  }).join("");
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
    if (nameForm) nameForm.classList.add("hidden");
  }
  if (type === "error") {
    nameStatus.textContent = data;
    nameStatus.className = "text-sm text-rose-400";
  }
  if (type === "active_sessions") {
    if (activeSessionsCountEl) activeSessionsCountEl.textContent = data;
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
    if (nameForm) {
      nameForm.classList.remove("hidden");
      nameInput.value = "";
    }
    nameStatus.textContent = "";
    nameStatus.className = "text-sm";
  }
  if (type === "leaderboard") {
    running = data.running;
    endsAt = Date.now() + data.endsInMs;
    renderBoard(data.top, data.duration || RACE_DURATION_SECONDS);
    if (running) updateTimer();
  }
};

setNameBtn.onclick = () => {
  ws.send(JSON.stringify({ type: "set_name", data: nameInput.value }));
};

clickBtn.onclick = () => {
  if (running) ws.send(JSON.stringify({ type: "click" }));
};
