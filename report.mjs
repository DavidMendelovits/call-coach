// node report.mjs <session-id>  →  reports/<id>/index.html: a self-contained replay page from a local session.
// The deployed app does the same thing behind a code at /r/<id> (see "Share recap").
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildReplay, replayHTML } from "./lib/recap.mjs";

const id = process.argv[2];
if (!/^[\w-]+$/.test(id || "")) throw new Error("usage: node report.mjs <session-id>");
const s = JSON.parse(await readFile(`sessions/${id}.json`, "utf8"));
const data = buildReplay(s);
await mkdir(`reports/${id}`, { recursive: true });
const sc = await readFile("views/scorecard.js", "utf8"); // inlined so the file works on its own
const template = (await readFile("views/replay.html", "utf8")).replace('<script src="/scorecard.js"></script>', () => `<script>${sc}</script>`);
await writeFile(`reports/${id}/index.html`, replayHTML(template, data));
console.log(`reports/${id}/index.html: ${s.lines.length} → ${data.lines.length} lines`);
