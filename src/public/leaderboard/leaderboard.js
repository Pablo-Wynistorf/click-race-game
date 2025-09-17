const boardEl = document.getElementById("board");
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function formatClicksPerSecond(entry) {
  if (entry && typeof entry.clicksPerSecond === "number") {
    return entry.clicksPerSecond.toFixed(2);
  }
  if (entry && typeof entry.score === "number") {
    const duration = typeof entry.raceDuration === "number" && entry.raceDuration > 0
      ? entry.raceDuration
      : 10;
    return (entry.score / duration).toFixed(2);
  }
  return "0.00";
}

function renderBoard(top) {
  boardEl.innerHTML = top.map((p, i) => {
    const score = typeof p?.score === "number" ? p.score : 0;
    const cps = formatClicksPerSecond({ ...p, score });
    const name = p?.username || p?.name || "Player";
    const finishedAt = typeof p?.finishedAt === "number"
      ? new Date(p.finishedAt).toLocaleString()
      : "";
    const raceId = p?.raceId || "";
    return `<tr>
      <td class="px-4 py-2">${i + 1}</td>
      <td class="px-4 py-2">${escapeHtml(name)}</td>
      <td class="px-4 py-2">${score}</td>
      <td class="px-4 py-2">${cps}</td>
      <td class="px-4 py-2">${escapeHtml(raceId)}</td>
      <td class="px-4 py-2">${escapeHtml(finishedAt)}</td>
    </tr>`;
  }).join("");
  if (top.length === 0) {
    boardEl.innerHTML = '<tr><td colspan="6" class="px-4 py-6 text-slate-500 text-center">No results yet.</td></tr>';
  }
}

async function load() {
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  renderBoard(data.top || []);
}

load();
