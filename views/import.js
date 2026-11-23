// Upload a transcript to coach a past call. Shared by both versions of the app.
// parse() turns pasted text or a .txt/.vtt/.srt/.md/.json file into speaker turns. mount() adds the dialog;
// the page passes start({ title, lines, walk }), which writes the recap and, if asked, walks the call with the coach.
// Nothing here talks to the server; the page decides where the lines go.
(() => {
  "use strict";
  const MAX_BYTES = 2e6;
  const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
  const toSec = (s) => {
    if (!s) return null;
    const p = s.replace(",", ".").split(":").map(Number);
    return p.some(isNaN) ? null : p.reduce((a, x) => a * 60 + x, 0);
  };
  // a speaker name: up to 5 words, starts with a letter, no sentence punctuation
  const NOT_NAMES = /^(https?|note|notes|summary|action items?|next steps?|agenda|topic|subject|date|time|title|attendees|participants|transcript|re|fwd?)$/i;
  const isName = (s) => {
    s = s.trim();
    return s.length > 0 && s.length <= 40 && /^[\p{L}][\p{L}\p{N} .'’()@&_-]*$/u.test(s) && s.split(/\s+/).length <= 5 && !NOT_NAMES.test(s);
  };
  const strip = (t) => t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

  // ---- formats: each returns [{ name, text, ts }]
  function fromJSON(text) {
    let d; try { d = JSON.parse(text) } catch { return null }
    const arr = Array.isArray(d) ? d : Array.isArray(d?.lines) ? d.lines : Array.isArray(d?.segments) ? d.segments : Array.isArray(d?.transcript) ? d.transcript : null;
    if (!arr) return null;
    const out = [];
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      const t = strip(String(x.text ?? x.content ?? x.words ?? ""));
      const name = String(x.speaker ?? x.who ?? x.name ?? x.role ?? "Speaker").trim() || "Speaker";
      const ts = typeof x.start === "number" ? x.start : typeof x.start === "string" ? toSec(x.start) : null;
      if (t) out.push({ name, text: t, ts });
    }
    return out.length ? out : null;
  }

  function fromCues(text) { // WebVTT and SRT
    if (!/-->/.test(text)) return null;
    const out = []; let speaker = null;
    for (const block of text.split(/\n\s*\n/)) {
      const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
      const at = rows.findIndex((r) => r.includes("-->"));
      if (at < 0) continue;
      const ts = toSec(rows[at].split("-->")[0].trim().match(new RegExp(TS))?.[0]);
      for (const row of rows.slice(at + 1)) {
        let name = null, t = row;
        const v = row.match(/^<v(?:\.[\w.]+)?\s+([^>]+)>(.*)$/);
        if (v) { name = v[1].trim(); t = v[2] }
        else { const c = row.match(/^([^:：]{1,40})[:：]\s*(.+)$/); if (c && isName(c[1])) { name = c[1].trim(); t = c[2] } }
        if (name) speaker = name;
        t = strip(t);
        if (t) out.push({ name: speaker || "Speaker", text: t, ts });
      }
    }
    return out.length ? out : null;
  }

  function fromPlain(text) {
    const out = []; let speaker = null, pendingTs = null;
    const tsName = new RegExp(String.raw`^[\[(]?(${TS})[\])]?\s*[-–—|]?\s*([^:：]{1,40}?)\s*[:：]\s*(.*)$`); // [00:01:02] Sam: text
    const nameTs = new RegExp(String.raw`^\**([^:：\[\]()]{1,40}?)\**\s*[\[(]?(${TS})[\])]?\s*[:：]\s*(.*)$`); // Sam (00:01:02): text
    const head = new RegExp(String.raw`^\[?\**([^\[\]:：]{1,40}?)\**\]?\s+[\[(]?(${TS})[\])]?\s*$`); // Sam  0:03   or  [Sam] 10:02:03 (text on next lines)
    const tsOnly = new RegExp(String.raw`^[\[(]?(${TS})[\])]?$`);
    const said = /^\**([^:：]{1,40}?)\**\s*[:：]\s*(.*)$/; // Sam: text
    const push = (name, t, ts) => {
      t = strip(t); speaker = name;
      if (ts != null) pendingTs = null;
      if (t) out.push({ name, text: t, ts: ts ?? pendingTs });
      pendingTs = null;
    };
    for (const raw of text.split("\n")) {
      const row = raw.replace(/^\s*[-*>]\s+/, "").trim();
      if (!row || /^(#+|={3,}|-{3,})/.test(row)) continue;
      let m;
      if ((m = row.match(tsOnly))) { pendingTs = toSec(m[1]); continue }
      if ((m = row.match(tsName)) && isName(m[2])) { push(m[2].trim(), m[3], toSec(m[1])); continue }
      if ((m = row.match(nameTs)) && isName(m[1])) { push(m[1].trim(), m[3], toSec(m[2])); continue }
      if ((m = row.match(head)) && isName(m[1])) { speaker = m[1].trim(); pendingTs = toSec(m[2]); continue }
      if ((m = row.match(said)) && isName(m[1])) { push(m[1].trim(), m[2], null); continue }
      if (speaker) {
        const last = out.at(-1);
        if (last && last.name === speaker && pendingTs == null) last.text += " " + strip(row);
        else push(speaker, row, null);
      } else out.push({ name: "Speaker", text: strip(row), ts: pendingTs });
    }
    return out.length ? out : null;
  }

  // merge back-to-back turns by the same speaker and carry timestamps forward
  function tidy(segs) {
    const out = []; let lastTs = null;
    for (const s of segs) {
      if (!s.text) continue;
      const ts = s.ts != null && isFinite(s.ts) ? s.ts : lastTs;
      if (ts != null) lastTs = ts;
      const prev = out.at(-1);
      if (prev && prev.name === s.name) prev.text += " " + s.text;
      else out.push({ name: s.name, text: s.text, ts });
    }
    return out;
  }

  function parse(text) {
    text = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const t = text.trim();
    if (!t) return { turns: [], speakers: [] };
    const segs = ((t[0] === "[" || t[0] === "{") && fromJSON(t)) || (/^WEBVTT/.test(t) || /^\d+\n[\d:,.]+ --> /.test(t) ? fromCues(t) : null) || fromPlain(t) || [];
    const turns = tidy(segs);
    const seen = new Map();
    for (const x of turns) {
      const k = x.name;
      const s = seen.get(k) || { name: k, turns: 0, words: 0 };
      s.turns++; s.words += (x.text.match(/\S+/g) || []).length; seen.set(k, s);
    }
    return { turns, speakers: [...seen.values()], timed: turns.some((x) => x.ts != null) };
  }

  // whose turn is "me": a name that says so, or the name picked last time; otherwise the person picks
  function guessMe(speakers) {
    const names = speakers.map((s) => s.name);
    const mine = names.find((n) => /^(me|you|i|myself)$/i.test(n));
    if (mine) return mine;
    let saved = ""; try { saved = localStorage.getItem("import.me") || "" } catch {}
    return saved && names.includes(saved) ? saved : "";
  }

  // turns → app lines { who, text, t }. With more than one other person, each "them" line keeps its speaker's name.
  function toLines(parsed, me) {
    const others = new Set(parsed.speakers.map((s) => s.name).filter((n) => n !== me));
    const many = others.size > 1;
    const last = Math.max(0, ...parsed.turns.map((x) => x.ts ?? 0));
    const base = Date.now() - last * 1000; // timed calls end "now"; only the gaps between lines matter
    const lines = [];
    for (const x of parsed.turns) {
      const who = x.name === me ? "me" : "them";
      const text = who === "them" && many ? `${x.name}: ${x.text}` : x.text;
      const t = x.ts != null ? new Date(base + x.ts * 1000).toISOString() : null;
      const prev = lines.at(-1);
      if (prev && prev.who === who && !many) prev.text += " " + text;
      else lines.push({ who, text, t });
    }
    return lines;
  }

  // ---- dialog
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function mount({ button, start, busy, note }) {
    const btn = typeof button === "string" ? document.querySelector(button) : button;
    if (!btn) return;
    const dlg = document.createElement("dialog");
    dlg.id = "importbox";
    dlg.innerHTML = `<form method="dialog" class="imp">
      <h2>Coach a past call</h2>
      <p>Paste a transcript or pick a text file (.txt, .vtt, .srt, .md or .json). ${esc(note || "")}</p>
      <label class="k" for="imp-title">Call title</label>
      <div class="field"><input id="imp-title" placeholder="e.g. Design review with Sam" autocomplete="off"></div>
      <div class="imp-src">
        <label class="mini imp-file">Choose file<input type="file" id="imp-file" accept=".txt,.vtt,.srt,.md,.json,.csv,text/plain,text/vtt,application/json" hidden></label>
        <span id="imp-fname"></span>
      </div>
      <textarea id="imp-text" rows="8" placeholder="Sam: Thanks for walking me through this.&#10;David: Happy to. What matters most to you here?"></textarea>
      <div id="imp-found" class="imp-found" aria-live="polite"></div>
      <div class="imp-me" id="imp-mewrap" hidden><label class="k" for="imp-me">Which speaker is you?</label><select id="imp-me"></select></div>
      <label class="imp-walk"><input type="checkbox" id="imp-walk" checked> Walk through the call with the coach (strategy and tips at points through the call; takes longer)</label>
      <p class="imp-err" id="imp-err" role="alert"></p>
      <div class="imp-actions"><button class="mini" value="cancel" formnovalidate>Cancel</button><button class="mini primary" id="imp-go" value="go" disabled>Coach this call</button></div>
    </form>`;
    document.body.append(dlg);
    const $ = (s) => dlg.querySelector(s);
    let parsed = null;
    const update = () => {
      parsed = parse($("#imp-text").value);
      const n = parsed.turns.length, sp = parsed.speakers;
      $("#imp-err").textContent = "";
      if (!n) { $("#imp-found").textContent = ""; $("#imp-mewrap").hidden = true; $("#imp-go").disabled = true; return }
      $("#imp-found").textContent = `${n} turns from ${sp.length} speaker${sp.length === 1 ? "" : "s"}${parsed.timed ? ", with timestamps" : ""}.`
        + (sp.length < 2 ? " Only one speaker found: put each line as “Name: what they said”." : "");
      const keep = $("#imp-me").value, guess = sp.some((s) => s.name === keep) ? keep : guessMe(sp);
      $("#imp-me").innerHTML = (guess ? "" : '<option value="">Pick one…</option>') + sp.map((s) => `<option value="${esc(s.name)}"${s.name === guess ? " selected" : ""}>${esc(s.name)} · ${s.words} words</option>`).join("");
      $("#imp-mewrap").hidden = false;
      ready();
    };
    const ready = () => { $("#imp-go").disabled = !parsed?.turns.length || parsed.speakers.length < 2 || !$("#imp-me").value };
    $("#imp-text").addEventListener("input", update);
    $("#imp-me").addEventListener("change", ready);
    $("#imp-file").addEventListener("change", async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      $("#imp-err").textContent = "";
      if (f.size > MAX_BYTES) { $("#imp-err").textContent = "That file is over 2 MB. Paste the part you want coached instead."; return }
      if (/\.(docx?|pdf|rtf|pages)$/i.test(f.name)) { $("#imp-err").textContent = "Save it as plain text first (.txt), or copy and paste the transcript here."; return }
      const text = await f.text();
      if (/\u0000/.test(text.slice(0, 2000))) { $("#imp-err").textContent = "That file isn't text. Save it as .txt, or copy and paste the transcript here."; return }
      $("#imp-text").value = text; $("#imp-fname").textContent = f.name;
      if (!$("#imp-title").value.trim()) $("#imp-title").value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 80);
      update();
    });
    btn.addEventListener("click", () => {
      if (busy?.()) return;
      $("#imp-err").textContent = "";
      dlg.showModal(); $("#imp-text").focus();
    });
    dlg.addEventListener("close", async () => {
      const me = $("#imp-me").value;
      if (dlg.returnValue !== "go" || !parsed?.turns.length || !me) return;
      try { localStorage.setItem("import.me", me) } catch {}
      const title = $("#imp-title").value.trim() || "Uploaded call";
      const walk = $("#imp-walk").checked;
      const lines = toLines(parsed, me);
      // reset for next time; the transcript now lives in the session
      $("#imp-text").value = ""; $("#imp-title").value = ""; $("#imp-fname").textContent = ""; $("#imp-file").value = ""; update();
      await start({ title, lines, walk });
    });
  }

  window.TranscriptImport = { parse, toLines, guessMe, mount };
})();
