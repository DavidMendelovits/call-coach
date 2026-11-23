// Turns a saved session into replay data: cleans transcription noise, merges same-speaker lines,
// remaps strategy/coach/review line numbers, and leaves out the private context box.
const NON_LATIN = /[^\x00-\x7FÀ-ɏ‘-‟…]+/g; // assumes English calls; stray CJK is VAD noise
const clean = (t) => String(t || "").replace(NON_LATIN, " ").replace(/\s+/g, " ").trim();
const keep = (t) => /[A-Za-z]{2,}/.test(t);

export function buildReplay(s) {
  const lines = [], pos = []; // pos[old index] = new line index it landed in
  for (const l of s.lines || []) {
    const text = clean(l.text);
    if (keep(text)) {
      if (lines.at(-1)?.who === l.who) lines.at(-1).text += " " + text;
      else lines.push({ who: l.who, text, t: l.t });
    }
    pos.push(lines.length - 1);
  }
  const at = (n) => (n > 0 ? pos[Math.min(n, pos.length) - 1] + 1 : 0); // 1-based line count → new count
  const remap = (h) => ({ ...h, at: at(h.at) });
  const review = s.review && {
    ...s.review,
    misses: (s.review.misses || []).map((m) => ({ ...m, line: Math.max(1, at(m.line)) })),
    goals: (s.review.goals || []).map((g) => ({ ...g, line: g.line > 0 ? Math.max(1, at(g.line)) : 0 })),
    objections: (s.review.objections || []).map((o) => ({ ...o, line: Math.max(1, at(o.line)) })),
  };
  return {
    title: s.title || "", startedAt: s.startedAt, reconstructed: !!s.reconstructed, mode: s.mode === "learning" ? "learning" : "sales", lines,
    strategyHistory: (s.strategyHistory || []).map(remap).filter((h) => h.at > 0),
    coachHistory: (s.coachHistory || []).map(remap).filter((h) => h.at > 0),
    review: review || null,
  };
}

// Replay page with the data inlined (no second fetch, works as a static file too).
export function replayHTML(template, data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const title = (data.title || "Call").replace(/[<>&"]/g, "");
  return template
    .replace("<title>Call Replay</title>", () => `<title>${title} replay</title>`)
    .replace("<!--DATA-->", () => `<script>window.REPLAY = ${json};</script>`); // function form: $ in the data stays literal
}
