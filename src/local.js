// Everything AI runs on this computer: speech to text in one worker, the coach model in another
// (or in Chrome itself). No API keys, and no audio or transcript leaves the browser for AI.
const webllm = () => import("@mlc-ai/web-llm"); // loaded only when Qwen is used

const QWEN = "Qwen3.5-2B-q4f16_1-MLC";
const CTX_TOKENS = 8192; // Qwen's context for this app: room for a ~4k-token transcript plus the recap
const LM_OPTS = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const stats = { stt: { state: "idle" }, llm: { state: "idle" }, mem: {} };
let listener = () => {};
const emit = () => { try { listener(stats) } catch (e) { console.warn(e) } };
const pref = { get: () => { try { return localStorage.getItem("engine") || "auto" } catch { return "auto" } }, set: (v) => { try { localStorage.setItem("engine", v) } catch {} } };

// ---------------- speech to text ----------------
let stt = null, sttReady = null, seq = 0;
const waiting = new Map();
function startSTT() {
  if (sttReady) return sttReady;
  stt?.terminate();
  stt = new Worker("/stt-worker.js", { type: "module" });
  Object.assign(stats.stt, { state: "loading", label: "Moonshine base", loaded: 0, total: 0, error: "" }); emit();
  sttReady = new Promise((resolve, reject) => {
    const fail = (msg) => { stats.stt.state = "error"; stats.stt.error = msg; emit(); sttReady = null; reject(new Error(msg)) };
    stt.onmessage = ({ data }) => {
      if (data.type === "progress") { stats.stt.loaded = data.loaded; stats.stt.total = data.total; emit() }
      else if (data.type === "ready") { Object.assign(stats.stt, data.info, { state: "ready" }); emit(); memory(); resolve() }
      else if (data.type === "error") fail(data.error);
      else if (data.type === "text") { waiting.get(data.id)?.(data); waiting.delete(data.id) }
    };
    stt.onerror = (e) => { e.preventDefault?.(); fail(e.message || "speech worker failed to start") };
  });
  stt.postMessage({ type: "load" });
  return sttReady;
}
// audio: Float32Array of 16 kHz mono. endedAt: performance.now() when the speaker stopped.
function transcribe(audio, endedAt) {
  const id = ++seq;
  const done = new Promise((resolve) => waiting.set(id, resolve));
  stt.postMessage({ type: "transcribe", id, audio }, [audio.buffer]);
  return done.then((r) => {
    const s = stats.stt, lag = (performance.now() - endedAt) / 1000;
    s.n = (s.n || 0) + 1;
    s.lagLast = lag; s.lagAvg = s.n === 1 ? lag : s.lagAvg * 0.8 + lag * 0.2;
    s.rtf = r.sec ? (s.rtf == null ? r.ms / 1000 / r.sec : s.rtf * 0.8 + (r.ms / 1000 / r.sec) * 0.2) : s.rtf; // compute time per second of audio
    s.audioSec = (s.audioSec || 0) + (r.sec || 0);
    if (r.error) s.lastError = r.error;
    emit();
    return r.text || "";
  });
}

// ---------------- coach model ----------------
let engine = null, kind = null, llmReady = null, queue = Promise.resolve();
async function chromeAvailability() {
  if (!("LanguageModel" in self)) return "unavailable";
  try { return await LanguageModel.availability(LM_OPTS) } catch { return "unavailable" }
}
async function hasGPU() { try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())) } catch { return false } }
function startLLM() {
  if (llmReady) return llmReady;
  llmReady = (async () => {
    const want = pref.get();
    const avail = want === "qwen" ? "unavailable" : await chromeAvailability();
    const chrome = want === "chrome" ? avail !== "unavailable" : avail === "available"; // auto: Chrome's model only if it's already on disk
    if (want === "chrome" && !chrome) throw new Error("Chrome's built-in AI isn't available in this browser (needs Chrome 148+ and enough disk and memory)");
    const t0 = performance.now();
    if (chrome) {
      stats.llm = { state: "loading", label: "Gemini Nano (built into Chrome)", device: "Chrome on-device", progress: 0 }; emit();
      const probe = await LanguageModel.create({ ...LM_OPTS, monitor(m) { m.addEventListener("downloadprogress", (e) => { stats.llm.progress = e.loaded; emit() }) } });
      stats.llm.window = probe.contextWindow ?? probe.inputQuota;
      probe.destroy();
      kind = "chrome"; engine = null;
    } else {
      if (!(await hasGPU())) throw new Error("this browser has no WebGPU, so the coach model can't run here. Use Chrome or Edge.");
      const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await webllm();
      const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === QWEN);
      stats.llm = { state: "loading", label: "Qwen 3.5 2B (4-bit)", device: "WebGPU", gpuMB: rec?.vram_required_MB, window: CTX_TOKENS, progress: 0 }; emit();
      engine = await CreateWebWorkerMLCEngine(new Worker("/llm-worker.js", { type: "module" }), QWEN,
        { initProgressCallback: (p) => { stats.llm.progress = p.progress; stats.llm.text = p.text; emit() } },
        { context_window_size: CTX_TOKENS });
      kind = "qwen";
    }
    Object.assign(stats.llm, { state: "ready", loadMs: Math.round(performance.now() - t0), progress: 1 }); emit(); memory();
  })().catch((e) => { llmReady = null; Object.assign(stats.llm, { state: "error", error: String(e.message || e) }); emit(); throw e });
  return llmReady;
}
async function switchEngine(v) {
  pref.set(v);
  await queue.catch(() => {});
  try { await engine?.unload?.() } catch {}
  engine = null; kind = null; llmReady = null;
  stats.llm = { state: "idle" }; emit();
}
function parse(text) {
  try { return JSON.parse(text) } catch {}
  const m = String(text).match(/\{[\s\S]*\}/); // tolerate stray words around the JSON
  if (m) try { return JSON.parse(m[0]) } catch {}
  throw new Error("the coach model returned something that isn't JSON");
}
function ask({ system, user, schema, max }) {
  const run = async () => {
    await startLLM();
    const t0 = performance.now();
    let text, outTok, tps, approx = false;
    if (kind === "chrome") {
      const s = await LanguageModel.create({ ...LM_OPTS, initialPrompts: [{ role: "system", content: system }] });
      try { text = await s.prompt(user, { responseConstraint: schema }) } finally { s.destroy() }
      outTok = Math.round(text.length / 4); tps = outTok / ((performance.now() - t0) / 1000); approx = true; // Chrome doesn't report tokens
    } else {
      const r = await engine.chat.completions.create({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object", schema: JSON.stringify(schema) },
        max_tokens: max, temperature: 0.3, extra_body: { enable_thinking: false },
      });
      text = r.choices[0].message.content || "";
      outTok = r.usage?.completion_tokens; tps = r.usage?.extra?.decode_tokens_per_s;
      stats.llm.prefillTps = r.usage?.extra?.prefill_tokens_per_s; stats.llm.ttft = r.usage?.extra?.time_to_first_token_s;
    }
    const s = stats.llm;
    s.calls = (s.calls || 0) + 1; s.tokensOut = (s.tokensOut || 0) + (outTok || 0);
    s.lastMs = Math.round(performance.now() - t0); s.tps = tps; s.approx = approx;
    emit();
    return parse(text);
  };
  const p = queue.then(run, run); // one request at a time on the GPU
  queue = p.catch(() => {});
  return p;
}
async function memory() {
  try { stats.mem.heapMB = performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null } catch {}
  try { const e = await navigator.storage.estimate(); stats.mem.diskMB = e.usage / 1e6 } catch {}
  emit();
}
setInterval(memory, 5000);

// ---------------- prompts ----------------
// Small models need room: keep the end of the transcript and the start of the context.
const charBudget = () => kind === "chrome" ? Math.max(3000, ((stats.llm.window || 4096) - 1800) * 3) : 16000;
const tail = (t, n) => (t.length > n ? "…" + t.slice(-n) : t);
const wrap = (context, transcript, empty) =>
  `<context>\n${(context || "(none)").slice(0, 2500)}\n</context>\n\n<transcript>\n${transcript || empty}\n</transcript>`;

const COACH_SCHEMA = {
  type: "object",
  properties: {
    now: { type: "string" },
    ask: { type: "array", items: { type: "object", properties: { q: { type: "string" }, why: { type: "string" } }, required: ["q", "why"], additionalProperties: false } },
    loose_ends: { type: "array", items: { type: "string" } },
    covered: { type: "array", items: { type: "string" } },
    watch: { type: "string" },
  },
  required: ["now", "ask", "loose_ends", "covered", "watch"], additionalProperties: false,
};
const COACH = `You are a live call coach whispering to the user during a real conversation. ME is the user, THEM is the other side. You see ME's private context and the latest transcript, which is auto-generated and may have errors.
Fill the JSON like this:
- now: the single most useful thing ME should do next, at most 15 words.
- ask: up to 3 short questions ME could say out loud next, each with a short why. Base them on what THEM just said.
- loose_ends: things THEM mentioned (numbers, names, pains, tools, doubts) that ME has not followed up on.
- covered: goals from the context that ME has already hit.
- watch: one short warning if ME is rambling, dodging the question, guessing, or missing a buying signal. Otherwise "".
Be specific to the transcript. No generic advice. If the call has barely started, suggest a strong opener from the context.`;

const PHASES = ["opener", "rapport", "discovery", "pitch", "objection", "closing", "wrap-up"];
const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string", enum: PHASES },
    temperature: { type: "string", enum: ["cold", "neutral", "warm", "hot"] },
    they_care_about: { type: "string" }, play: { type: "string" }, avoid: { type: "string" },
  },
  required: ["phase", "temperature", "they_care_about", "play", "avoid"], additionalProperties: false,
};
const STRATEGY = `You read a live conversation and call the play, like a coach on the sideline. ME is the user, THEM is the other side. Weight the last few lines most.
- phase: where the call is now.
- temperature: how THEM feels about it.
- they_care_about: what THEM is optimizing for, in their words, at most 12 words.
- play: the move ME should make in the next 15 seconds, at most 12 words.
- avoid: one thing ME should not do right now, at most 10 words, or "".`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    went_well: { type: "array", items: { type: "string" } },
    misses: { type: "array", items: { type: "object", properties: { line: { type: "integer" }, what: { type: "string" }, better: { type: "string" } }, required: ["line", "what", "better"], additionalProperties: false } },
    next_step: { type: "string" },
    follow_up_email: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"], additionalProperties: false },
    crm_notes: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "object", properties: { goal: { type: "string" }, status: { type: "string", enum: ["hit", "partial", "missed"] }, line: { type: "integer" }, evidence: { type: "string" } }, required: ["goal", "status", "line", "evidence"], additionalProperties: false } },
    objections: { type: "array", items: { type: "object", properties: { line: { type: "integer" }, objection: { type: "string" }, response: { type: "string" }, outcome: { type: "string", enum: ["handled", "partly", "not_handled"] } }, required: ["line", "objection", "response", "outcome"], additionalProperties: false } },
  },
  required: ["summary", "went_well", "misses", "next_step", "follow_up_email", "crm_notes", "goals", "objections"], additionalProperties: false,
};
const REVIEW = `You are a call QA reviewer. You read a finished call between ME (the user) and THEM and write the recap a sales manager would want. Lines are numbered like [12].
Fill the JSON like this:
- summary: what happened and where it ended, 2 or 3 sentences.
- went_well: 2 to 4 specific things ME did well.
- misses: the 2 to 5 moments that cost ME the most, in call order. line = the line number, what = what ME did, better = what to say instead.
- next_step: the agreed next step, or "None agreed" plus what ME should propose.
- follow_up_email: a plain email from ME to THEM, under 120 words.
- crm_notes: 3 to 6 short notes: their priorities, concerns, people, timeline, stage.
- goals: one entry per goal listed in the context, in order. status "hit" only when the transcript clearly shows it. line = the best line number, or 0.
- objections: each time THEM pushed back or doubted something, in call order. Not neutral questions.
Only use facts from the transcript and context. Write plainly, no buzzwords.`;

// Learning style: THEM knows more, ME is there to learn and to practice asking good questions.
const COACH_LEARN = `You are a live learning coach whispering to the user. THEM knows more about the topic; ME is there to learn it and to practice asking good questions. You see ME's private context and the latest transcript, which is auto-generated and may have errors.
Fill the JSON like this:
- now: the question habit ME should use next, at most 15 words. Example: "Ask why before they move on."
- ask: up to 3 short open questions ME could say out loud next, each with a short why. Base them on THEM's exact words: a term, a claim, a number, a skipped step. Mix kinds: clarify a term, ask why, ask for an example, ask what breaks or the tradeoff, connect it to something ME knows, play it back. Prefer questions that go deeper or sideways over "and then what".
- loose_ends: terms, claims, numbers or ideas THEM mentioned that ME has not asked about yet.
- covered: goals or habits from the context that ME has already done on this call.
- watch: one short warning if ME is nodding along without checking, asking yes/no questions, only asking what comes next, or talking more than listening. Otherwise "".
Be specific to the transcript. No generic advice. If the call has barely started, suggest an opener that says what ME wants to learn.`;
const LEARN_PHASES = ["orient", "explain", "probe", "example", "apply", "recap"];
const STRATEGY_LEARN_SCHEMA = { ...STRATEGY_SCHEMA, properties: { ...STRATEGY_SCHEMA.properties, phase: { type: "string", enum: LEARN_PHASES } } };
const STRATEGY_LEARN = `You read a live learning conversation like a coach on the sideline. THEM knows more; ME is learning. Weight the last few lines most.
- phase: orient (setting up what to learn), explain (THEM explaining), probe (ME asking follow-ups), example (working a concrete case), apply (ME trying it or playing it back), recap.
- temperature: how engaged THEM is.
- they_care_about: the core idea THEM is explaining right now, at most 12 words.
- play: the question move ME should make in the next 15 seconds, at most 12 words.
- avoid: one thing ME should not do right now, at most 10 words, or "".`;
const REVIEW_LEARN = `You review a finished learning conversation. THEM knows more about the topic; ME was there to learn and to practice asking good questions. Lines are numbered like [12].
Fill the JSON like this:
- summary: what was covered and how well ME seems to understand it, 2 or 3 sentences.
- went_well: 2 to 4 good questions or moments of learning from ME, with the moment.
- misses: 2 to 5 moments where ME let something pass that deserved a question, in order. line = the line number, what = what THEM said that ME didn't ask about, better = the question to ask.
- next_step: what ME should read, try or ask next to keep learning.
- follow_up_email: a short thank-you from ME to THEM with one or two follow-up questions, under 120 words.
- crm_notes: 3 to 6 short notes of what ME learned, in plain words.
- goals: one entry per goal listed in the context, in order. status "hit" only when the transcript clearly shows it. line = the best line number, or 0.
- objections: each question ME asked, in order. objection = the question, response = how THEM answered, outcome "handled" = clear answer, "partly", "not_handled" = left open or ME moved on.
Only use facts from the transcript and context. Write plainly, no buzzwords.`;
const learning = (mode) => mode === "learning";

async function coach({ context, transcript, mode }) {
  await startLLM();
  const t = tail(transcript || "", Math.min(7000, charBudget() * 0.6));
  return ask({ system: learning(mode) ? COACH_LEARN : COACH, schema: COACH_SCHEMA, max: 500, user: `${wrap(context, t, "(call hasn't started yet)")}\n\nCoach me for the next 30 seconds. At most 3 questions.` });
}
async function strategy({ context, transcript, mode }) {
  await startLLM();
  return ask({ system: learning(mode) ? STRATEGY_LEARN : STRATEGY, schema: learning(mode) ? STRATEGY_LEARN_SCHEMA : STRATEGY_SCHEMA, max: 200, user: wrap(context.slice(0, 1200), tail(transcript || "", 2500), "(not started)") });
}
async function review({ context, lines, mode }) {
  if (!lines?.length) throw new Error("nothing to review yet");
  await startLLM();
  const all = lines.map((l, i) => `[${i + 1}] ${l.who.toUpperCase()}: ${l.text}`);
  const budget = charBudget(); let used = 0, from = all.length;
  while (from > 0 && used + all[from - 1].length + 1 <= budget) used += all[--from].length + 1;
  const transcript = (from > 0 ? `(lines 1 to ${from} left out: too long for the local model)\n` : "") + all.slice(from).join("\n");
  const out = await ask({ system: learning(mode) ? REVIEW_LEARN : REVIEW, schema: REVIEW_SCHEMA, max: 1600, user: `${wrap(context, transcript, "")}\n\nWrite the post-call recap.` });
  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= lines.length ? n : 0; // small models sometimes invent line numbers
  for (const k of ["misses", "goals", "objections"]) for (const x of out[k] || []) x.line = ok(x.line);
  out.misses = (out.misses || []).filter((x) => x.line > 0);
  if (from > 0) out.partial = `Covers lines ${from + 1} to ${lines.length}; earlier lines didn't fit the local model.`;
  return out;
}

// ---------------- stats readout (shared by the app and the check page) ----------------
const mb = (bytes) => !bytes ? "" : bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + " GB" : Math.round(bytes / 1e6) + " MB";
const sec = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
const bar = (f) => `<div class="bar"><i style="width:${Math.round(100 * Math.min(1, f || 0))}%"></i></div>`;
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function statsHTML(s = stats) {
  const t = s.stt, m = s.llm, x = s.mem, out = [];
  if (t.state === "idle") out.push(`<div class="st"><b>Speech:</b> Moonshine base, loads on Start</div>`);
  else if (t.state === "loading") out.push(`<div class="st"><b>Speech:</b> downloading ${t.total ? Math.round(100 * t.loaded / t.total) + "% of " + mb(t.total) : "…"}${bar(t.total && t.loaded / t.total)}</div>`);
  else if (t.state === "error") out.push(`<div class="st err"><b>Speech:</b> ${esc(t.error)}</div>`);
  else out.push(`<div class="st"><b>Speech:</b> ${esc(t.model)} on ${t.device === "webgpu" ? "GPU" : "CPU"}, ${mb(t.bytes)}, ready in ${sec(t.loadMs)}${t.n ? `<br>${t.lagAvg.toFixed(1)} s behind speech · ${(1 / t.rtf).toFixed(0)}× real time` : ""}</div>`);
  if (m.state === "idle") out.push(`<div class="st"><b>Coach:</b> loads on Start</div>`);
  else if (m.state === "loading") out.push(`<div class="st"><b>Coach:</b> ${esc(m.label)}, loading ${Math.round(100 * (m.progress || 0))}%${m.gpuMB ? `, needs ${mb(m.gpuMB * 1e6)} GPU memory` : ""}${bar(m.progress)}</div>`);
  else if (m.state === "error") out.push(`<div class="st err"><b>Coach:</b> ${esc(m.error)}</div>`);
  else out.push(`<div class="st"><b>Coach:</b> ${esc(m.label)}, ready in ${sec(m.loadMs)}${m.gpuMB ? `, ${mb(m.gpuMB * 1e6)} GPU` : ""}${m.calls ? `<br>${m.approx ? "~" : ""}${Math.round(m.tps || 0)} tokens/s · last answer ${sec(m.lastMs)} · ${m.calls} calls` : ""}</div>`);
  if (x.diskMB || x.heapMB) out.push(`<div class="st">${x.diskMB ? `Models cached: ${mb(x.diskMB * 1e6)}` : ""}${x.heapMB ? ` · page memory ${mb(x.heapMB * 1e6)}` : ""}</div>`);
  return out.join("");
}

window.LocalAI = {
  statsHTML,
  stats, startSTT, startLLM, transcribe, coach, strategy, review, chromeAvailability, hasGPU, switchEngine, memory,
  get engine() { return pref.get() }, set onStats(fn) { listener = fn; emit() },
};
dispatchEvent(new Event("localai"));
