// JSON documents by key ("sessions/<id>", "recaps/<id>", "locks/<id>").
// On Vercel: a private Vercel Blob store. Locally (no blob credentials): files under ./data, sessions under ./sessions.
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";

const KEY = /^(sessions|recaps|locks)\/[\w-]{1,80}$/;
const check = (key) => { if (!KEY.test(key)) throw Object.assign(new Error("bad id"), { status: 400 }); return key };
export const usingBlob = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

let sdk;
const blob = async () => (sdk ??= await import("@vercel/blob"));

const root = new URL("../", import.meta.url);
const dirFor = (prefix) => new URL(prefix === "sessions" ? "sessions/" : `data/${prefix}/`, root);
const fileFor = (key) => { const [p, id] = key.split("/"); return new URL(`${id}.json`, dirFor(p)) };

export async function getJSON(key) {
  check(key);
  if (usingBlob()) {
    const { get } = await blob();
    const r = await get(`${key}.json`, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return new Response(r.stream).json();
  }
  try { return JSON.parse(await readFile(fileFor(key), "utf8")) } catch (e) { if (e.code === "ENOENT") return null; throw e }
}

export async function putJSON(key, obj) {
  check(key);
  const body = JSON.stringify(obj);
  if (usingBlob()) {
    const { put } = await blob();
    await put(`${key}.json`, body, { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60 });
    return;
  }
  const [p] = key.split("/");
  await mkdir(dirFor(p), { recursive: true });
  await writeFile(fileFor(key), body);
}

export async function delKey(key) {
  check(key);
  if (usingBlob()) { const { del } = await blob(); return del(`${key}.json`) }
  await rm(fileFor(key), { force: true });
}

export async function listIds(prefix) {
  if (usingBlob()) {
    const { list } = await blob();
    const ids = []; let cursor;
    do {
      const r = await list({ prefix: `${prefix}/`, cursor, limit: 1000 });
      for (const b of r.blobs) ids.push(b.pathname.slice(prefix.length + 1).replace(/\.json$/, ""));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return ids;
  }
  try { return (await readdir(dirFor(prefix))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) }
  catch (e) { if (e.code === "ENOENT") return []; throw e }
}
