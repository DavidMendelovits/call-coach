// Local server: same routes as Vercel, served with node:http. Sessions go to ./sessions, recaps to ./data.
// npm start  →  http://localhost:4777
import http from "node:http";
import { Readable } from "node:stream";
import { handle } from "./lib/app.mjs";

const PORT = +process.env.PORT || 4777;

http.createServer(async (req, res) => {
  try {
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

for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "APP_PASSCODE"]) if (!process.env[k]) console.warn(`⚠ ${k} missing from .env`);
process.on("unhandledRejection", (e) => console.error("unhandled", e));
