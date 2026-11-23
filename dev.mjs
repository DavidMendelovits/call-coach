// Local server: same routes as Vercel, served with node:http. Static files come from ./public. Sessions go to ./sessions, recaps to ./data.
// npm start  →  http://localhost:4777
import http from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { handle } from "./lib/app.mjs";

// Mirror Vercel: files in ./public are served as-is, with the workers' CSP from vercel.json.
const vercel = JSON.parse(await readFile(new URL("./vercel.json", import.meta.url), "utf8"));
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".txt": "text/plain" };
async function staticFile(path) {
  if (path === "/" || path.includes("..")) return null;
  const body = await readFile(new URL("./public" + path, import.meta.url)).catch(() => null);
  if (!body) return null;
  const headers = { "content-type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream" };
  for (const h of vercel.headers) if (new RegExp("^" + h.source.replace("(.*)", ".*") + "$").test(path)) for (const { key, value } of h.headers) headers[key.toLowerCase()] = value;
  return { body, headers };
}

const PORT = +process.env.PORT || 4777;

http.createServer(async (req, res) => {
  try {
    const file = req.method === "GET" && await staticFile(new URL(req.url, "http://x").pathname);
    if (file) { res.writeHead(200, file.headers); return res.end(file.body) }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const response = await handle(request);
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end("server error");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Call coach → http://localhost:${PORT}`));

for (const k of ["APP_PASSCODE"]) if (!process.env[k]) console.warn(`⚠ ${k} missing from .env`);
process.on("unhandledRejection", (e) => console.error("unhandled", e));
