// Speech to text, fully in the browser: Moonshine (an English speech model) via transformers.js.
// One worker serves both lanes ("me" and "them"); utterances are transcribed in arrival order.
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useWasmCache = false; // no blob: scripts; the CSP only allows this origin
const ORT = new URL("/ort/", self.location.origin).href; // ONNX Runtime's wasm is served by this app, not a CDN
env.backends.onnx.wasm.wasmPaths = { mjs: ORT + "ort-wasm-simd-threaded.asyncify.mjs", wasm: ORT + "ort-wasm-simd-threaded.asyncify.wasm" };

let asr = null, loading = null, queue = Promise.resolve();

async function load() {
  const t0 = performance.now();
  const adapter = self.navigator?.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  const device = adapter ? "webgpu" : "wasm";
  // WebGPU: full-precision encoder + 4-bit decoder (~155 MB). No GPU: 8-bit model on the CPU (~63 MB).
  const model = "onnx-community/moonshine-base-ONNX";
  const dtype = adapter ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "quantized", decoder_model_merged: "quantized" };
  let bytes = 0, lastPost = 0;
  asr = await pipeline("automatic-speech-recognition", model, {
    device, dtype,
    progress_callback: (p) => {
      if (p.status !== "progress_total") return;
      bytes = p.total;
      const now = performance.now();
      if (now - lastPost > 250) { lastPost = now; postMessage({ type: "progress", loaded: p.loaded, total: p.total }) }
    },
  });
  await asr(new Float32Array(16000), { max_new_tokens: 4 }); // warm-up: compiles GPU shaders before the call starts
  return { model: "Moonshine base", device, bytes, loadMs: Math.round(performance.now() - t0) };
}

self.onmessage = ({ data }) => {
  if (data.type === "load") {
    loading ??= load().then(
      (info) => postMessage({ type: "ready", info }),
      (e) => { loading = null; postMessage({ type: "error", error: String(e?.message || e) }) },
    );
  } else if (data.type === "transcribe") {
    queue = queue.then(async () => {
      try {
        await loading;
        const t0 = performance.now(), sec = data.audio.length / 16000;
        const out = await asr(data.audio, { max_new_tokens: Math.ceil(sec * 6) + 4 });
        postMessage({ type: "text", id: data.id, text: (out?.text || "").trim(), ms: Math.round(performance.now() - t0), sec });
      } catch (e) {
        postMessage({ type: "text", id: data.id, text: "", error: String(e?.message || e) });
      }
    });
  }
};
