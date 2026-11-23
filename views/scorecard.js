// Scorecard tab for the post-call recap, shared by the app and the shared replay page.
// Talk stats come straight from the transcript; goals and objections come from the Claude recap.
// Every row with a line number is a button with data-line (1-based); each page wires the jump.
(() => {
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const words = (t) => (String(t).match(/[A-Za-z0-9']+/g) || []).length;
  const questions = (t) => (String(t).match(/\?/g) || []).length;

  function stats(lines) {
    const w = { me: 0, them: 0 }, q = { me: 0, them: 0 };
    let longest = null;
    lines.forEach((l, i) => {
      const n = words(l.text);
      w[l.who] = (w[l.who] || 0) + n; q[l.who] = (q[l.who] || 0) + questions(l.text);
      if (l.who === "me" && (!longest || n > longest.words)) longest = { line: i + 1, words: n };
    });
    const total = w.me + w.them;
    const times = lines.map((l) => Date.parse(l.t)).filter((x) => x > 0);
    const minutes = times.length > 1 ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60000)) : null;
    return { mePct: total ? Math.round((100 * w.me) / total) : 0, total, q, longest, minutes };
  }

  const STATUS = { hit: ["Hit", "ok"], partial: ["Partly", "warn"], missed: ["Missed", "bad"] };
  const OUTCOME = { handled: ["Handled", "ok"], partly: ["Partly", "warn"], not_handled: ["Not handled", "bad"] };
  const jump = (line, inner, cls = "") => line > 0
    ? `<button class="sc-row sc-jump ${cls}" data-line="${+line}">${inner}<small>line ${+line}</small></button>`
    : `<div class="sc-row ${cls}">${inner}</div>`;
  const pill = ([label, tone]) => `<span class="sc-pill ${tone}">${label}</span>`;

  function html(review, lines, mode) {
    const M = window.CoachModes ? CoachModes.get(mode) : { objections: "Objections", objectionsEmpty: "No pushback on this call.", outcome: { handled: "Handled", partly: "Partly", not_handled: "Not handled" } };
    const OUT = { handled: [M.outcome.handled, "ok"], partly: [M.outcome.partly, "warn"], not_handled: [M.outcome.not_handled, "bad"] };
    const s = stats(lines || []);
    const ratioNote = s.mePct > 60 ? "You did most of the talking" : s.mePct < 40 ? "They did most of the talking" : "Balanced";
    const goals = review?.goals || [], objs = review?.objections || [];
    const hit = goals.filter((g) => g.status === "hit").length;
    return `<div class="sc">
      <div class="sc-tiles">
        <div class="sc-tile"><b>${s.mePct}%</b><span>you talking · ${ratioNote.toLowerCase()}</span><i style="--p:${s.mePct}%"></i></div>
        <div class="sc-tile"><b>${s.q.me}</b><span>questions you asked · they asked ${s.q.them}</span></div>
        ${s.longest ? `<button class="sc-tile sc-jump" data-line="${s.longest.line}"><b>${s.longest.words}</b><span>words in your longest turn · line ${s.longest.line}</span></button>` : ""}
        ${goals.length ? `<div class="sc-tile"><b>${hit}/${goals.length}</b><span>goals hit</span></div>` : s.minutes ? `<div class="sc-tile"><b>${s.minutes} min</b><span>call length</span></div>` : ""}
      </div>
      <div class="sc-h">Goals</div>
      ${goals.length ? goals.map((g) => jump(g.line, `${pill(STATUS[g.status] || STATUS.missed)}<span><b>${esc(g.goal)}</b><em>${esc(g.evidence)}</em></span>`)).join("")
        : `<p class="sc-empty">${!review ? "Goals are scored when the recap is written." : !review.goals ? "This recap is older than the scorecard. Rewrite it to score goals." : "No goals in the call context to score against."}</p>`}
      <div class="sc-h">${M.objections}</div>
      ${objs.length ? objs.map((o) => jump(o.line, `${pill(OUT[o.outcome] || OUT.partly)}<span><b>${esc(o.objection)}</b><em>${esc(o.response)}</em></span>`)).join("")
        : `<p class="sc-empty">${!review ? `${M.objections} are listed when the recap is written.` : !review.objections ? "This recap is older than the scorecard. Rewrite it to list objections." : M.objectionsEmpty}</p>`}
    </div>`;
  }

  const css = `
  .sc { display:flex; flex-direction:column; gap:6px }
  .sc-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; margin-bottom:6px }
  .sc-tile { all:unset; box-sizing:border-box; position:relative; overflow:hidden; display:flex; flex-direction:column; gap:2px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg) }
  .sc-tile b { font-size:22px; font-weight:700; line-height:1.1 } .sc-tile span { font-size:12px; color:var(--dim) }
  .sc-tile i { position:absolute; left:0; bottom:0; height:3px; width:var(--p); background:var(--fg) }
  button.sc-tile, .sc-row.sc-jump { cursor:pointer } button.sc-tile:hover, .sc-row.sc-jump:hover { border-color:var(--line2, var(--dim)) }
  .sc-jump:focus-visible { outline:2px solid var(--fg); outline-offset:1px }
  .sc-h { font-size:11.5px; font-weight:600; color:var(--dim); letter-spacing:.05em; text-transform:uppercase; margin-top:8px }
  .sc-row { all:unset; box-sizing:border-box; display:flex; gap:10px; align-items:flex-start; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); font-size:13px }
  .sc-row > span { display:flex; flex-direction:column; gap:1px; flex:1; min-width:0 } .sc-row em { font-style:normal; color:var(--dim) }
  .sc-row small { font:500 11px ui-monospace, Menlo, monospace; color:var(--faint, var(--dim)); white-space:nowrap; margin-top:2px }
  .sc-pill { flex:none; font-size:11px; font-weight:600; padding:2px 7px; border-radius:99px; margin-top:1px; min-width:52px; text-align:center }
  .sc-pill.ok { color:var(--ok, #8fe388); background:color-mix(in srgb, var(--ok, #8fe388) 14%, transparent) }
  .sc-pill.warn { color:var(--fg); background:transparent; box-shadow:inset 0 0 0 1px var(--line2, var(--dim)) }
  .sc-pill.bad { color:var(--hot, #ff5a3c); background:color-mix(in srgb, var(--hot, #ff5a3c) 14%, transparent) }
  .sc-empty { margin:0; font-size:13px; color:var(--dim) }
  .sc-tabs { display:flex; gap:4px } .sc-tabs button { all:unset; cursor:pointer; font-size:12.5px; font-weight:600; padding:3px 10px; border-radius:6px; color:var(--dim) }
  .sc-tabs button[aria-selected="true"] { background:var(--fg); color:var(--on-fg, #121314) } .sc-tabs button:focus-visible { outline:2px solid var(--fg) }`;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

  window.Scorecard = { stats, html };
})();
