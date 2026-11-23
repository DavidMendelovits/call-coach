// Bundles the in-browser AI code into public/ so the app serves every script itself (no CDN at runtime).
// Vercel runs this as the build step. Model weights still download from Hugging Face on first use.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const common = { bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "none", logLevel: "info" };
await build({ ...common, entryPoints: { "stt-worker": "src/stt-worker.js", "llm-worker": "src/llm-worker.js", local: "src/local.js" }, outdir: "public", splitting: true, chunkNames: "chunks/[name]-[hash]" });
await mkdir("public/ort", { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"])
  await cp(`node_modules/onnxruntime-web/dist/${f}`, `public/ort/${f}`);
