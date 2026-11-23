// What the AI is doing, in the open: which model each part uses, every call it makes and how long it took.
// Live calls get a small tooltip on the panel each call updates (out, then back). Long jobs, like coaching
// an uploaded call, get a progress panel that names each step. Shared by both versions of the app.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const secs = (ms) => ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
  const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

  // ---------- models ----------
  // role -> { role, title, model, where, note }. The page registers its roles; the server or the
  // on-device engine can correct the model name after a call (e.g. a fallback model answered).
  const models = new Map();
  function setModel(role, info) {
    const before = models.get(role), next = { ...(before || { role }), ...info };
    if (before && JSON.stringify(before) === JSON.stringify(next)) return; // no redraw when nothing changed
    models.set(role, next); emit({ type: "models" });
  }

  // ---------- calls ----------
  const log = []; let seq = 0; const subs = new Set();
  const emit = (e) => subs.forEach((f) => { try { f(e) } catch (err) { console.warn(err) } });
  const pending = (role) => log.filter((e) => e.state === "out" && (!role || e.role === role)).length;
  const api = { live: false };

  // begin() for calls that don't fit a promise (streamed transcription); track() for everything else.
  function begin({ role, label, target, detail, quiet }) {
    const m = models.get(role) || {};
    const e = { id: ++seq, role, label: label || m.title || role, model: m.model || "", detail: detail || "", at: new Date(), t0: performance.now(), state: "out" };
    log.unshift(e); if (log.length > 300) log.pop();
    const tip = api.live && !quiet && target ? tipOn(target, e) : null;
    emit({ type: "call", e });
    const end = (state, info = {}) => {
      if (e.state !== "out") return;
      Object.assign(e, info, { state, ms: performance.now() - e.t0 });
      tip?.settle(); emit({ type: "call", e });
    };
    return { e, ok: (info) => end("ok", info), fail: (err) => end("err", { error: String(err?.message || err) }) };
  }
  async function track(opts, fn) {
    const h = begin(opts);
    try {
      const out = await fn(h.e);
      const meta = out && typeof out === "object" ? out._meta : null;
      if (meta) {
        delete out._meta;
        if (meta.model && meta.model !== h.e.model) setModel(opts.role, { model: meta.model, answered: meta.model });
      }
      h.ok(meta ? { model: meta.model || h.e.model, tokensIn: meta.in, tokensOut: meta.out } : {});
      return out;
    } catch (err) { h.fail(err); throw err }
  }

  // ---------- tooltips during a live call ----------
  // One bubble per panel. It shows the newest call to that panel: "↗ out" with a timer, then "↙ back in 1.2 s".
  const bubbles = new Map();
  function tipOn(target, e) {
    const el = typeof target === "string" ? $(target) : target; if (!el) return null;
    let b = bubbles.get(el);
    if (!b) { b = { node: Object.assign(document.createElement("div"), { className: "tip", role: "status" }), el, timer: 0, tick: 0, calls: new Set() }; document.body.append(b.node); bubbles.set(el, b) }
    b.calls.add(e);
    const draw = () => {
      const open = [...b.calls].filter((c) => c.state === "out"), show = open[open.length - 1] || e;
      b.node.className = `tip show ${show.state}`;
      const dir = show.state === "out" ? `<span class="spin" aria-hidden="true"></span><span class="dir">↗ out</span>` : show.state === "ok" ? `<span class="dir">↙ back</span>` : `<span class="dir">✕ failed</span>`;
      const ms = show.state === "out" ? performance.now() - show.t0 : show.ms;
      b.node.innerHTML = `${dir}<span>${esc(show.label)}</span><span class="m">${esc(short(show.model))}</span><span class="ms">${secs(ms)}${open.length > 1 ? ` · ${open.length} out` : ""}</span>${show.state === "err" ? `<span class="m">${esc(show.error).slice(0, 60)}</span>` : ""}`;
      place(b);
    };
    clearTimeout(b.timer); clearInterval(b.tick);
    b.tick = setInterval(() => (b.calls.size && [...b.calls].some((c) => c.state === "out") ? draw() : null), 100);
    draw();
    return {
      settle() {
        draw();
        if ([...b.calls].some((c) => c.state === "out")) return;
        clearInterval(b.tick); b.calls.clear();
        b.timer = setTimeout(() => b.node.classList.remove("show"), e.state === "err" ? 4500 : 2200);
      },
    };
  }
  function place(b) {
    const r = b.el.getBoundingClientRect(); const w = b.node.offsetWidth, h = b.node.offsetHeight;
    const visible = r.bottom > 0 && r.top < innerHeight;
    b.node.style.visibility = visible ? "" : "hidden";
    b.node.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w - 8)) + "px";
    b.node.style.top = Math.max(8, r.top - h - 6) + "px";
  }
  addEventListener("scroll", () => bubbles.forEach(place), true);
  addEventListener("resize", () => bubbles.forEach(place));
  const short = (m) => String(m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");

  // ---------- activity dialog: models + every call ----------
  let filter = null;
  function stats(role) {
    const L = log.filter((e) => e.role === role && e.state !== "out"), ok = L.filter((e) => e.state === "ok");
    const avg = ok.length ? ok.reduce((s, e) => s + e.ms, 0) / ok.length : null;
    return { n: L.length, err: L.length - ok.length, avg, out: pending(role) };
  }
  function drawLog() {
    const dlg = $("#activitybox"); if (!dlg?.open) return;
    dlg.querySelector(".models").innerHTML = [...models.values()].map((m) => {
      const s = stats(m.role);
      return `<button class="model${filter === m.role ? " on" : ""}" data-role="${esc(m.role)}" aria-pressed="${filter === m.role}">
        <span class="r">${esc(m.title || m.role)}</span><span class="n">${esc(m.model || "not loaded")}</span>
        <span class="w">${esc(m.where || "")}</span>
        <span class="s">${s.n ? `${s.n} call${s.n === 1 ? "" : "s"}${s.avg != null ? ` · avg ${secs(s.avg)}` : ""}${s.err ? ` · ${s.err} failed` : ""}` : "no calls yet"}${s.out ? ` · ${s.out} out now` : ""}</span>
        ${m.note ? `<span class="w">${esc(m.note)}</span>` : ""}</button>`;
    }).join("");
    const L = log.filter((e) => !filter || e.role === filter).slice(0, 150);
    dlg.querySelector("tbody").innerHTML = L.length ? L.map((e) => `<tr>
      <td>${clock(e.at)}</td><td>${esc(e.label)}${e.detail ? `<br><span class="m" style="color:var(--dim)">${esc(e.detail)}</span>` : ""}</td>
      <td>${esc(e.model)}</td>
      <td class="r">${e.state === "out" ? secs(performance.now() - e.t0) : secs(e.ms)}</td>
      <td class="r">${e.tokensIn != null ? `${e.tokensIn.toLocaleString()} / ${(e.tokensOut ?? 0).toLocaleString()}` : ""}</td>
      <td class="st-${e.state}">${e.state === "out" ? "waiting" : e.state === "ok" ? "back" : "failed"}${e.error ? `<div class="err">${esc(e.error)}</div>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="6" style="color:var(--dim)">No calls yet${filter ? " for this model" : ""}. They show up here as soon as the app asks a model anything.</td></tr>`;
  }
  function openLog(role) {
    filter = role || null;
    const dlg = $("#activitybox"); if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    drawLog();
  }
  setInterval(() => { if (pending()) drawLog() }, 250);
  document.addEventListener("click", (e) => {
    const m = e.target.closest("#activitybox .model"); if (m) { filter = filter === m.dataset.role ? null : m.dataset.role; drawLog() }
    const o = e.target.closest("[data-activity]"); if (o) openLog(o.dataset.activity || null);
  });
  subs.add(() => drawLog());

  // ---------- long jobs ----------
  // job({ title, sub, steps:[{ key, label, note }] }) shows a big panel. The page reports each step:
  // start(key, note), progress(key, done, total, note), done(key, note), fail(key, note). Hide shrinks it to a chip.
  const CUBE = (state) => {
    const C = Math.cos(Math.PI / 6), S = 0.5, s = 9, cx = 11, cy = 11;
    const p = (x, y, z) => `${(cx + (x - y) * C * s).toFixed(1)},${(cy + (x + y) * S * s - z * s).toFixed(1)}`;
    return `<svg class="c cube ${state}" viewBox="0 0 22 22" aria-hidden="true">
      <polygon class="face side" points="${p(1, 0, 0)} ${p(1, 1, 0)} ${p(1, 1, 1)} ${p(1, 0, 1)}" transform="translate(0 -1.5)"/>
      <polygon class="face" points="${p(0, 1, 0)} ${p(1, 1, 0)} ${p(1, 1, 1)} ${p(0, 1, 1)}" transform="translate(0 -1.5)"/>
      <polygon class="face top" points="${p(0, 0, 1)} ${p(1, 0, 1)} ${p(1, 1, 1)} ${p(0, 1, 1)}" transform="translate(0 -1.5)"/></svg>`;
  };
  let cur = null;
  function job({ title, sub, steps, onStop, stopLabel = "Stop" }) {
    cur?.close?.();
    const box = $("#job"), chip = $("#jobchip");
    const S = steps.map((s) => ({ ...s, state: "todo", done: 0, total: 0, t0: 0, ms: 0, note: s.note || "" }));
    const t0 = performance.now(); let finished = null, hidden = false;
    const at = () => S.findIndex((s) => s.state === "now");
    const frac = () => {
      const n = S.length; let f = 0;
      for (const s of S) f += s.state === "done" ? 1 : s.state === "now" && s.total ? s.done / s.total : 0;
      return f / n;
    };
    function draw() {
      const i = at(), s = S[i], f = finished ? 1 : frac(), ind = !finished && s && !s.total;
      box.querySelector("h2").textContent = title;
      box.querySelector(".sub").textContent = finished?.msg || sub || "";
      box.querySelector(".jbar").innerHTML = `<div class="meter${finished?.err ? " err" : ""}"><i style="width:${Math.round(f * 100)}%"></i></div>
        <div class="jnums"><span>${finished ? (finished.err ? "Stopped" : "Done") : s ? `Step ${i + 1} of ${S.length}: ${esc(s.label)}` : "Starting"}</span><span>${Math.round(f * 100)}% · ${secs(performance.now() - t0)}</span></div>`;
      box.querySelector("ol").innerHTML = S.map((x) => `<li class="${x.state}">${CUBE(x.state)}<span class="lb">${esc(x.label)}</span>
        <span class="tm">${x.state === "now" ? secs(performance.now() - x.t0) : x.state === "done" || x.state === "err" ? secs(x.ms) : ""}</span>
        ${x.note ? `<span class="nt">${esc(x.note)}</span>` : ""}
        ${x.state === "now" ? `<div class="meter${x.total ? "" : " ind"}"><i style="width:${x.total ? Math.round((100 * x.done) / x.total) : 0}%"></i></div>` : ""}</li>`).join("");
      const f2 = box.querySelector(".jf");
      f2.innerHTML = finished ? `<button class="btn primary" data-j="close">${esc(finished.cta || "Done")}</button>`
        : `<button class="btn" data-j="hide">Hide</button>${onStop ? `<button class="btn" data-j="stop">${esc(stopLabel)}</button>` : ""}`;
      chip.classList.toggle("on", hidden && !finished);
      chip.innerHTML = `<span>${s ? esc(s.label) : esc(title)}${s?.total ? ` ${s.done}/${s.total}` : ""}</span><span class="meter${ind ? " ind" : ""}"><i style="width:${Math.round(f * 100)}%"></i></span>`;
      ind && chip.querySelector(".meter").classList.add("ind");
    }
    const tick = setInterval(() => !finished && draw(), 200);
    box.onclick = (e) => {
      const b = e.target.closest("[data-j]"); if (!b) return;
      if (b.dataset.j === "hide") { hidden = true; box.classList.remove("on"); draw() }
      if (b.dataset.j === "stop") { onStop?.(); ctl.finish("Stopped. Whatever finished is kept.", { err: true, cta: "Close" }) }
      if (b.dataset.j === "close") ctl.close();
    };
    chip.onclick = () => { hidden = false; box.classList.add("on"); draw() };
    const step = (key) => S.find((s) => s.key === key);
    const ctl = {
      start(key, note) { const s = step(key); Object.assign(s, { state: "now", t0: performance.now(), note: note ?? s.note }); draw() },
      progress(key, done, total, note) { const s = step(key); if (s.state !== "now") ctl.start(key); Object.assign(s, { done, total }); if (note != null) s.note = note; draw() },
      done(key, note) { const s = step(key); if (s.state === "todo") s.t0 = performance.now(); Object.assign(s, { state: "done", ms: performance.now() - s.t0 }); if (note != null) s.note = note; draw() },
      skip(key, note) { const s = step(key); Object.assign(s, { state: "done", ms: 0, note: note ?? "skipped" }); draw() },
      fail(key, note) { const s = step(key); Object.assign(s, { state: "err", ms: s.t0 ? performance.now() - s.t0 : 0, note: note ?? s.note }); draw() },
      finish(msg, { err = false, cta } = {}) { if (finished) return; finished = { msg, err, cta }; S.forEach((s) => s.state === "now" && Object.assign(s, { state: err ? "err" : "done", ms: performance.now() - s.t0 })); hidden = false; box.classList.add("on"); draw(); clearInterval(tick) },
      close() { clearInterval(tick); box.classList.remove("on"); chip.classList.remove("on"); if (cur === ctl) cur = null },
      get active() { return !finished },
    };
    box.classList.add("on"); draw();
    return (cur = ctl);
  }

  Object.assign(api, { setModel, models, begin, track, log, pending, on: (f) => (subs.add(f), () => subs.delete(f)), openLog, job, secs, short });
  window.Activity = api;
})();
