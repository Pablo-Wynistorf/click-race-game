const boardEl = document.getElementById("board");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderBoard(top) {
  boardEl.innerHTML = top.map((p, i) =>
    `<tr>
      <td class="px-4 py-2">${i + 1}</td>
      <td class="px-4 py-2">${escapeHtml(p.name || "Player")}</td>
      <td class="px-4 py-2">${p.score}</td>
      <td class="px-4 py-2">${p.raceId}</td>
      <td class="px-4 py-2">${new Date(p.finishedAt).toLocaleString()}</td>
    </tr>`
  ).join("");
  if (top.length === 0) {
    boardEl.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-slate-500 text-center">No results yet.</td></tr>';
  }
}

async function load() {
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  renderBoard(data.top || []);
}

load();
