// Signed cookies, recap codes and a small attempt limiter. The on-device app uses them only for links shared by an earlier version.
import { createHash, createHmac, timingSafeEqual, randomBytes, randomInt, scryptSync } from "node:crypto";
import { getJSON, putJSON, delKey } from "./store.mjs";

// Cookie signing key. SESSION_SECRET is optional here: without it the key is derived from the passcode
// plus the Blob token Vercel sets (server-only, random), so APP_PASSCODE is the only setting to add.
// Changing the passcode signs everyone out.
let derived;
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (s) {
    if (s.length < 32) throw Object.assign(new Error("SESSION_SECRET is shorter than 32 characters"), { status: 500 });
    return s;
  }
  const pass = process.env.APP_PASSCODE;
  if (!pass) throw Object.assign(new Error("APP_PASSCODE is not set"), { status: 500 });
  const salt = process.env.BLOB_READ_WRITE_TOKEN || "call-coach-local";
  return (derived ??= scryptSync(pass, `cookie-key|${salt}`, 32));
};
const mac = (s) => createHmac("sha256", secret()).update(s).digest("base64url");
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// token = "<expiry ms>.<hmac(scope|expiry)>"; the scope ties it to the app or to one recap
export const makeToken = (scope, days) => { const exp = Date.now() + days * 864e5; return `${exp}.${mac(`${scope}|${exp}`)}` };
export function checkToken(scope, token) {
  const [exp, sig] = String(token || "").split(".");
  if (!exp || !sig || !(+exp > Date.now())) return false;
  return safeEqual(sig, mac(`${scope}|${exp}`));
}

export function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
export function cookie(name, value, { path = "/", maxAge, secure }) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax", secure && "Secure"].filter(Boolean).join("; ");
}

const sha = (s) => createHash("sha256").update(String(s)).digest();
export function passcodeOk(input) {
  const want = process.env.APP_PASSCODE;
  if (!want) throw Object.assign(new Error("APP_PASSCODE is not set"), { status: 500 });
  return timingSafeEqual(sha(input), sha(want));
}

// Recap codes: 8 characters with no look-alikes (no 0/O, 1/I/L). Only a salted scrypt hash is stored.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
export const newId = () => randomBytes(12).toString("base64url");
export const newSalt = () => randomBytes(16).toString("base64url");
export const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
export const hashCode = (code, salt) => scryptSync(normalizeCode(code), salt, 32).toString("base64url");

// Limiter: after `max` failures, lock the key for `ms`.
export async function lockedUntil(key) {
  const l = await getJSON(`locks/${key}`);
  return l?.until > Date.now() ? l.until : 0;
}
export async function recordFailure(key, max, ms) {
  const l = (await getJSON(`locks/${key}`)) || { fails: 0 };
  l.fails = (l.until > Date.now() ? 0 : l.fails) + 1;
  if (l.fails >= max) { l.until = Date.now() + ms; l.fails = 0 }
  await putJSON(`locks/${key}`, l);
  return l.until > Date.now() ? l.until : 0;
}
export const clearFailures = (key) => delKey(`locks/${key}`);
