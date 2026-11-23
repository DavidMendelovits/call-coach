// Meeting history, kept in this browser only (IndexedDB). There are no accounts: whoever uses this
// browser profile sees its calls and nobody else does. Clearing the site's data removes them.
// Shared by both versions of the app.
(() => {
  "use strict";
  const DB = "call-coach", VER = 1;
  const mem = { sessions: new Map(), meta: new Map() }; // fallback when IndexedDB is unavailable (private windows)
  let dbp = null, persisted = false;
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function open() {
    return (dbp ??= new Promise((ok, no) => {
      if (!window.indexedDB) return no(new Error("IndexedDB is not available"));
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { r.result.createObjectStore("sessions", { keyPath: "id" }); r.result.createObjectStore("meta", { keyPath: "id" }) };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error("history is open in another tab with an older version"));
    }).catch((e) => { console.warn("history kept in memory only:", e); api.memoryOnly = true; return null }));
  }
  const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) });
  const done = (t) => new Promise((ok, no) => { t.oncomplete = () => ok(); t.onerror = t.onabort = () => no(t.error) });

  const words = (t) => (String(t).match(/[A-Za-z0-9']+/g) || []).length;
  function summarize(s) {
    const L = s.lines || [], times = L.map((l) => Date.parse(l.t)).filter((x) => x > 0);
    const w = { me: 0, them: 0 }; for (const l of L) w[l.who] = (w[l.who] || 0) + words(l.text);
    const goals = s.review?.goals || [];
    return {
      id: s.id, title: s.title || "", startedAt: s.startedAt, savedAt: new Date().toISOString(),
      lines: L.length, imported: !!s.imported,
      minutes: !s.imported && times.length > 1 ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60000)) : null,
      mePct: w.me + w.them ? Math.round((100 * w.me) / (w.me + w.them)) : null,
      recap: !!s.review, goalsHit: goals.filter((g) => g.status === "hit").length, goals: goals.length,
      summary: String(s.review?.summary || L.slice(0, 2).map((l) => l.text).join(" ")).slice(0, 220),
      shared: (s.shared || []).length,
    };
  }

  async function put(s) {
    const meta = summarize(s), d = await open();
    if (!persisted) { persisted = true; navigator.storage?.persist?.().catch(() => {}) } // ask the browser not to evict history
    if (!d) { mem.sessions.set(s.id, structuredClone(s)); mem.meta.set(s.id, meta); return meta }
    const t = d.transaction(["sessions", "meta"], "readwrite");
    t.objectStore("sessions").put(s); t.objectStore("meta").put(meta);
    await done(t); return meta;
  }
  async function get(id) {
    const d = await open();
    if (!d) return structuredClone(mem.sessions.get(id) || null);
    return (await req(d.transaction("sessions").objectStore("sessions").get(id))) || null;
  }
  async function list() {
    const d = await open();
    const all = d ? await req(d.transaction("meta").objectStore("meta").getAll()) : [...mem.meta.values()];
    return all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  async function del(id) {
    const d = await open();
    if (!d) { mem.sessions.delete(id); mem.meta.delete(id); return }
    const t = d.transaction(["sessions", "meta"], "readwrite");
    t.objectStore("sessions").delete(id); t.objectStore("meta").delete(id);
    await done(t);
  }

  // A random id for this browser. Links shared by an earlier version are tagged with a hash of it, so each browser lists and revokes only its own.
  let fallbackKey = null;
  function browserKey() {
    try {
      let k = localStorage.getItem("browser-key");
      if (!k) { k = crypto.randomUUID(); localStorage.setItem("browser-key", k) }
      return k;
    } catch { return (fallbackKey ??= crypto.randomUUID()) }
  }

  // ---------- display ----------
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) };
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };
  const name = (m) => m.title || (m.imported ? "Uploaded call" : "Untitled call");
  function day(iso) {
    const d = new Date(iso); if (isNaN(d)) return "Earlier";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
    return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: diff < 7 ? "long" : undefined, month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }
  const facts = (m) => [m.minutes ? `${m.minutes} min` : null, `${m.lines} lines`, m.mePct != null ? `you ${m.mePct}%` : null].filter(Boolean);
  const tags = (m) => [
    m.imported ? `<span class="tag">Uploaded</span>` : `<span class="tag">Live</span>`,
    m.goals ? `<span class="tag${m.goalsHit === m.goals ? " ok" : ""}">${m.goalsHit}/${m.goals} goals</span>` : m.recap ? `<span class="tag ok">Recap</span>` : "",
    m.shared ? `<span class="tag">Shared</span>` : "",
  ].join("");

  function rowHTML(m, cur) {
    return `<button class="hrow${m.id === cur ? " cur" : ""}" data-id="${esc(m.id)}" title="${esc(name(m))}">
      <span class="ht">${esc(name(m))}</span><span class="hb">${m.recap ? (m.goals ? `${m.goalsHit}/${m.goals}` : "recap") : ""}</span>
      <span class="hm">${esc(when(m.startedAt))} · ${esc(facts(m).slice(0, 2).join(" · "))}${m.id === cur ? " · open" : ""}</span></button>`;
  }
  function cardHTML(m, cur) {
    return `<div class="hcard${m.id === cur ? " cur" : ""}" data-id="${esc(m.id)}" role="button" tabindex="0" aria-label="Open ${esc(name(m))}">
      <div class="ht">${esc(name(m))}</div>
      <div class="hx"><div class="tags">${tags(m)}</div><button class="mini" data-del="${esc(m.id)}" aria-label="Delete ${esc(name(m))}">Delete</button></div>
      <div class="hm"><span>${esc(time(m.startedAt))}</span>${facts(m).map((f) => `<span>${esc(f)}</span>`).join("")}${m.id === cur ? "<span>open now</span>" : ""}</div>
      ${m.summary ? `<div class="hs">${esc(m.summary)}</div>` : ""}</div>`;
  }

  // Sidebar list (recent few) + full history dialog. The page passes what "open" and "delete" mean.
  function mount({ sidebar, dialog, button, current, onOpen, onDelete, recent = 4 }) {
    const side = document.querySelector(sidebar), dlg = document.querySelector(dialog);
    const body = dlg.querySelector(".db"), q = dlg.querySelector("input[type=search]"), foot = dlg.querySelector(".df .n");
    let all = [];
    const filtered = () => {
      const s = q.value.trim().toLowerCase();
      return !s ? all : all.filter((m) => (name(m) + " " + m.summary).toLowerCase().includes(s));
    };
    function drawDialog() {
      const cur = current(), L = filtered();
      if (!all.length) body.innerHTML = `<p class="empty">No calls yet. Each call you run or upload is saved here, in this browser only.</p>`;
      else if (!L.length) body.innerHTML = `<p class="empty">Nothing matches “${esc(q.value)}”.</p>`;
      else {
        let out = "", last = "";
        for (const m of L) { const d = day(m.startedAt); if (d !== last) { out += `<div class="hday">${esc(d)}</div>`; last = d } out += cardHTML(m, cur) }
        body.innerHTML = out;
      }
      foot.textContent = `${all.length} call${all.length === 1 ? "" : "s"} saved in this browser${api.memoryOnly ? " (this window can't save, so they go when you close it)" : ""}`;
    }
    async function refresh() {
      try { all = await list() } catch (e) { console.warn(e); all = [] }
      paint(); return all;
    }
    function paint() {
      const cur = current();
      if (side) side.innerHTML = all.length ? all.slice(0, recent).map((m) => rowHTML(m, cur)).join("") : `<div class="empty">No calls yet</div>`;
      document.querySelectorAll("[data-recent]").forEach((el) => {
        el.hidden = !all.length;
        const box = el.querySelector(".recent"); if (box) box.innerHTML = all.slice(0, 3).map((m) => rowHTML(m, cur)).join("");
      });
      document.querySelectorAll("[data-history-count]").forEach((el) => (el.textContent = all.length > recent ? `All ${all.length}` : all.length ? "All" : ""));
      if (dlg.open) drawDialog();
    }
    const openRow = (id) => { if (dlg.open) dlg.close(); onOpen(id) };
    document.addEventListener("click", (e) => {
      const r = e.target.closest(".hrow[data-id]"); if (r) openRow(r.dataset.id);
    });
    body.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const m = all.find((x) => x.id === del.dataset.del);
        if (!confirm(`Delete "${name(m || {})}" from this browser? This can't be undone. Recap files you downloaded stay where you saved them.`)) return;
        await del_(del.dataset.del); return;
      }
      const c = e.target.closest(".hcard[data-id]"); if (c) openRow(c.dataset.id);
    });
    body.addEventListener("keydown", (e) => { const c = e.target.closest(".hcard[data-id]"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRow(c.dataset.id) } });
    q.addEventListener("input", drawDialog);
    async function del_(id) { await del(id); await onDelete?.(id); refresh() }
    const show = () => { q.value = ""; drawDialog(); dlg.showModal(); refresh() };
    document.querySelectorAll(button).forEach((b) => b.addEventListener("click", show));
    refresh();
    return { refresh, show, paint, get list() { return all } };
  }

  const api = { put, get, list, del, summarize, browserKey, mount, memoryOnly: false };
  window.CallHistory = api;
})();
