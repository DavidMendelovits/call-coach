// One router for every route. Vercel runs it as api/index.mjs; locally dev.mjs serves it with node:http.
import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { getJSON, putJSON, delKey, listIds } from "./store.mjs";
import {
  readCookies, cookie, makeToken, checkToken, passcodeOk, newCode, newId, newSalt, hashCode, safeEqual,
  lockedUntil, recordFailure, clearFailures,
} from "./auth.mjs";
import { buildReplay, replayHTML } from "./recap.mjs";

const APP_DAYS = 30, RECAP_DAYS = 14;
const LOGIN_MAX = 10, RECAP_MAX = 5, LOCK_MS = 15 * 60e3;

const views = {};
const view = async (name) => (views[name] ??= await readFile(new URL(`../views/${name}`, import.meta.url), "utf8"));

// Headers on every response: nothing cached, indexed, framed or leaked through the referrer.
const SECURITY = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "microphone=(self), display-capture=(self), camera=(), geolocation=(), payment=(), usb=()",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...SECURITY, "content-type": "application/json", ...extra } });
// HTML gets a per-response CSP nonce: only our own inline scripts run, so injected markup can't execute.
// The page itself only talks to this origin. Model downloads happen inside the two AI workers,
// whose own CSP (vercel.json) allows Hugging Face and nothing else.
function html(body, status = 200, extra = {}) {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "worker-src 'self'",
    "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
  return new Response(body.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`), {
    status, headers: { ...SECURITY, "content-type": "text/html; charset=utf-8", "content-security-policy": csp, ...extra },
  });
}
// The audio worklet is served as a file so the CSP needs no blob: scripts. It hands 128-sample float frames and their level to the page.
const WORKLET = `class P extends AudioWorkletProcessor { process(i){ const c=i[0][0]; if(c){ const o=new Float32Array(c); let s=0;
  for(let k=0;k<c.length;k++) s+=c[k]*c[k]; this.port.postMessage({pcm:o, rms:Math.sqrt(s/c.length)},[o.buffer]) } return true } }
registerProcessor("pcm", P)`;
const redirect = (to, setCookie) => {
  const h = new Headers({ ...SECURITY, location: to });
  if (setCookie) h.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers: h });
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const minutesLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60e3));

// Small form page for the passcode and recap code (works without JS).
const formPage = ({ title, lead, action, field, label, error, autocomplete = "off" }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#121314; --card:#1a1b1c; --raise:#212223; --line:#2d2b27; --line2:#3d3a34; --fg:#e9e4da; --on-fg:#121314; --dim:#9a9488; --hot:#ff5a3c;
    --mono:"JetBrains Mono",ui-monospace,Menlo,monospace; --display:"Chakra Petch","JetBrains Mono",sans-serif; color-scheme:dark }
  * { box-sizing:border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:14px/1.55 var(--mono); padding:16px; -webkit-font-smoothing:antialiased }
  form { width:100%; max-width:360px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:24px; display:flex; flex-direction:column; gap:12px }
  .ws { display:flex; align-items:center; gap:8px; font:600 14px/1 var(--display); letter-spacing:.02em; margin-bottom:4px }
  .ws i { width:22px; height:22px; border-radius:5px; background:var(--fg); color:var(--on-fg); display:grid; place-items:center; font:700 12px/1 var(--display); font-style:normal }
  .ws small { color:var(--dim); font:400 12.5px var(--mono) }
  h1 { font:700 19px/1.2 var(--display); letter-spacing:.02em; margin:0 } p { margin:0; color:var(--dim); font-size:12.5px }
  label { font-size:12.5px; color:var(--dim) }
  input { font:500 16px var(--mono); letter-spacing:.08em; padding:10px 12px; border:1px solid var(--line2); border-radius:6px; background:var(--bg); color:var(--fg); width:100% }
  input:focus-visible, button:focus-visible { outline:2px solid var(--fg); outline-offset:2px }
  button { font:600 12.5px/1.2 var(--mono); padding:11px; border:1px solid var(--fg); border-radius:6px; background:var(--fg); color:var(--on-fg); cursor:pointer; box-shadow:0 2px 0 #77716a; margin-top:4px }
  button:active { transform:translateY(2px); box-shadow:none }
  .err { color:var(--hot); font-size:12.5px }
</style></head><body>
<form method="post" action="${esc(action)}">
  <div class="ws"><i>C</i><div>Call Coach</div></div>
  <h1>${esc(title)}</h1>${lead ? `<p>${esc(lead)}</p>` : ""}
  <label for="f">${esc(label)}</label>
  <input id="f" name="${field}" type="${field === "passcode" ? "password" : "text"}" autocomplete="${autocomplete}" autocapitalize="characters" spellcheck="false" required autofocus>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
  <button>Continue</button>
</form></body></html>`;

const loginPage = (error, status = 200) =>
  html(formPage({ title: "Call Coach", lead: "Enter the passcode to use the app.", action: "/login", field: "passcode", label: "Passcode", error, autocomplete: "current-password" }), status);
const unlockPage = (id, error, status = 200) =>
  html(formPage({ title: "Call recap", lead: "Enter the code you were sent with this link.", action: `/r/${id}/unlock`, field: "code", label: "Access code", error }), status);

async function readBody(request, max = 5e6) {
  const text = await request.text();
  if (text.length > max) throw Object.assign(new Error("request too large"), { status: 413 });
  try { return JSON.parse(text || "{}") } catch { throw Object.assign(new Error("bad JSON"), { status: 400 }) }
}
const formValue = async (request, name) => {
  try { return String((await request.formData()).get(name) || "") } catch { return "" }
};

// No accounts: each browser sends a random id it keeps in localStorage. Recaps store only a hash of it,
// so the list shows each browser the recaps it shared (plus older ones from before this, which have no owner).
const ownerOf = (request) => {
  const k = request.headers.get("x-coach-browser") || "";
  return /^[\w-]{8,80}$/.test(k) ? createHash("sha256").update("coach-browser:" + k).digest("hex").slice(0, 32) : null;
};
// What a shared recap may hold. The page sends the whole call; only these fields reach buildReplay, and the context box never does.
const str = (x, n) => String(x ?? "").slice(0, n);
function cleanSession(s) {
  if (!s || typeof s !== "object" || !Array.isArray(s.lines)) return null;
  const hist = (a, k) => (Array.isArray(a) ? a : []).slice(-400).filter((x) => x && Number.isFinite(+x.at) && x[k] && typeof x[k] === "object").map((x) => ({ at: +x.at, t: str(x.t, 40), [k]: x[k] }));
  return {
    id: str(s.id, 80), title: str(s.title, 200), startedAt: str(s.startedAt, 40), reconstructed: !!s.reconstructed, mode: s.mode === "learning" ? "learning" : "sales",
    lines: s.lines.slice(0, 5000).filter((l) => l && (l.who === "me" || l.who === "them") && typeof l.text === "string").map((l) => ({ who: l.who, text: l.text.slice(0, 4000), t: str(l.t, 40) })),
    strategyHistory: hist(s.strategyHistory, "strategy"), coachHistory: hist(s.coachHistory, "coach"),
    review: s.review && typeof s.review === "object" ? s.review : null,
  };
}
async function recapSummaries(origin, owner) {
  const ids = await listIds("recaps");
  const all = await Promise.all(ids.map((id) => getJSON(`recaps/${id}`).catch(() => null)));
  return all.filter(Boolean)
    .filter((r) => !expired(r) && (!r.owner || r.owner === owner))
    .map((r) => ({ id: r.id, title: r.title, sessionId: r.sessionId, createdAt: r.createdAt, expiresAt: expiresAt(r), url: `${origin}/r/${r.id}` }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Recaps stop opening RECAP_DAYS after they're shared (older recaps without expiresAt count from createdAt).
const expiresAt = (r) => r.expiresAt || new Date(Date.parse(r.createdAt) + RECAP_DAYS * 864e5).toISOString();
const expired = (r) => !(Date.parse(expiresAt(r)) > Date.now());
const goneRecap = (why) => html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Recap not available</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#121314;color:#e9e4da;font:14px/1.55 ui-monospace,Menlo,monospace;padding:16px"><p style="max-width:360px;margin:0">${why}</p></body>`, 404);

const ID = "([\\w-]{1,80})";
const route = (path, re) => path.match(new RegExp(`^${re}$`));

export async function handle(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("__path") || url.pathname; // vercel.json rewrites everything to /api/index?__path=…
  const method = request.method;
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  const origin = `${proto}://${host}`;
  const secure = proto === "https";
  const jar = readCookies(request);
  const authed = checkToken("app", jar.coach);

  try {
    // Reject cross-site writes (cookies are SameSite=Lax too)
    if (method !== "GET" && method !== "HEAD") {
      const from = request.headers.get("origin");
      if (from && from !== "null" && new URL(from).host !== host) return json({ error: "cross-site request" }, 403);
    }

    // ---- passcode login for the app
    if (path === "/login" && method === "POST") {
      const until = await lockedUntil("login");
      if (until) return loginPage(`Too many wrong tries. Try again in ${minutesLeft(until)} min.`, 429);
      if (!passcodeOk(await formValue(request, "passcode"))) {
        const locked = await recordFailure("login", LOGIN_MAX, LOCK_MS);
        return loginPage(locked ? `Too many wrong tries. Try again in ${minutesLeft(locked)} min.` : "That passcode didn't work.", 401);
      }
      await clearFailures("login");
      return redirect("/", cookie("coach", makeToken("app", APP_DAYS), { maxAge: APP_DAYS * 86400, secure }));
    }
    if (path === "/logout" && method === "POST") return redirect("/", cookie("coach", "", { maxAge: 0, secure }));

    // ---- shared recaps: /r/<id>, open with a code or an app login
    let m;
    if ((m = route(path, `/r/${ID}`)) && method === "GET") {
      const rec = await getJSON(`recaps/${m[1]}`);
      if (!rec) return goneRecap("This recap doesn't exist or was revoked.");
      if (expired(rec)) { await delKey(`recaps/${rec.id}`); return goneRecap("This recap has expired. Ask for a new link.") }
      if (!authed && !checkToken(`recap:${rec.id}`, jar[`rc_${rec.id}`])) return unlockPage(rec.id);
      return html(replayHTML(await view("replay.html"), rec.data));
    }
    if ((m = route(path, `/r/${ID}/unlock`)) && method === "POST") {
      const rec = await getJSON(`recaps/${m[1]}`);
      if (!rec || expired(rec)) return redirect(`/r/${m[1]}`);
      const key = `recap-${rec.id}`;
      const until = await lockedUntil(key);
      if (until) return unlockPage(rec.id, `Too many wrong codes. Try again in ${minutesLeft(until)} min.`, 429);
      if (!safeEqual(hashCode(await formValue(request, "code"), rec.salt), rec.codeHash)) {
        const locked = await recordFailure(key, RECAP_MAX, LOCK_MS);
        return unlockPage(rec.id, locked ? `Too many wrong codes. Try again in ${minutesLeft(locked)} min.` : "That code didn't work.", 401);
      }
      await clearFailures(key);
      return redirect(`/r/${rec.id}`, cookie(`rc_${rec.id}`, makeToken(`recap:${rec.id}`, RECAP_DAYS), { path: `/r/${rec.id}`, maxAge: RECAP_DAYS * 86400, secure }));
    }

    // shared by the app and shared recaps; holds no data
    if (path === "/modes.js" && method === "GET") return new Response(await view("modes.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/scorecard.js" && method === "GET") return new Response(await view("scorecard.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/studio.js" && method === "GET") return new Response(await view("studio.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/import.js" && method === "GET") return new Response(await view("import.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/history.js" && method === "GET") return new Response(await view("history.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/activity.js" && method === "GET") return new Response(await view("activity.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/app.css" && method === "GET") return new Response(await view("app.css"), { headers: { ...SECURITY, "content-type": "text/css; charset=utf-8" } });
    if (path === "/dictate.js" && method === "GET") return new Response(await view("dictate.js"), { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    // no data behind these: the audio worklet and a page that downloads and times the on-device models
    if (path === "/pcm-worklet.js" && method === "GET") return new Response(WORKLET, { headers: { ...SECURITY, "content-type": "text/javascript; charset=utf-8" } });
    if (path === "/check" && method === "GET") return html(await view("check.html"));

    // ---- everything below needs the app passcode
    if (!authed) return path.startsWith("/api/") ? json({ error: "signed out" }, 401) : loginPage();

    if (path === "/" && method === "GET") return html(await view("app.html"));
    if (path === "/how-it-works" && method === "GET") return html(await view("how-it-works.html"));

    // Calls saved on the server before history moved into the browser (Nov 23). Read only: each browser can copy them in once.
    if (path === "/api/older-calls" && method === "GET") {
      const ids = (await listIds("sessions")).slice(-200);
      const all = await Promise.all(ids.map(async (id) => ({ id, s: await getJSON(`sessions/${id}`).catch(() => null) })));
      return json(all.filter((x) => x.s?.lines?.length).map(({ id, s }) => ({ id, title: String(s.title || ""), startedAt: s.startedAt || null, lines: s.lines.length })));
    }
    if ((m = route(path, `/api/older-calls/${ID}`)) && method === "GET") {
      const s = await getJSON(`sessions/${m[1]}`);
      return s ? json({ ...s, id: m[1] }) : json({ error: "not found" }, 404);
    }
    if (path === "/api/recaps" && method === "GET") return json(await recapSummaries(origin, ownerOf(request)));
    if (path === "/api/recaps" && method === "POST") {
      const s = cleanSession((await readBody(request)).session);
      if (!s || !s.lines.length) return json({ error: "there's no transcript to share yet" }, 400);
      const id = newId(), code = newCode(), salt = newSalt();
      const data = buildReplay(s);
      const now = Date.now(), until = new Date(now + RECAP_DAYS * 864e5).toISOString();
      await putJSON(`recaps/${id}`, { id, sessionId: s.id, title: data.title, createdAt: new Date(now).toISOString(), expiresAt: until, owner: ownerOf(request), salt, codeHash: hashCode(code, salt), data });
      return json({ id, url: `${origin}/r/${id}`, code, title: data.title, expiresAt: until });
    }
    if ((m = route(path, `/api/recaps/${ID}`)) && method === "DELETE") {
      const rec = await getJSON(`recaps/${m[1]}`);
      if (rec?.owner && rec.owner !== ownerOf(request)) return json({ error: "only the browser that shared this recap can revoke it" }, 403);
      await delKey(`recaps/${m[1]}`);
      await clearFailures(`recap-${m[1]}`);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    let status = e?.status || 500, msg = String(e?.message || e);
    return json({ error: msg }, status);
  }
}
