const boardEl = document.getElementById("board");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function renderBoard(top) {
  boardEl.innerHTML = top.map((p,i)=>
    `<div class="flex justify-between px-4 py-2 bg-slate-900"><span>${i+1}. ${escapeHtml(p.name||"Player")}</span><span>${p.score} - ${new Date(p.finishedAt).toLocaleString()}</span></div>`
  ).join("");
  if (top.length === 0) {
    boardEl.innerHTML = '<div class="px-4 py-6 text-slate-500 text-center bg-slate-900">No results yet.</div>';
  }
}

async function load() {
  const res = await fetch('/api/leaderboard');
  const data = await res.json();
  renderBoard(data.top || []);
}

load();
