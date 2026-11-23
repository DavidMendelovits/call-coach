// Claude calls: live coach (slow lane), strategy read (fast lane), post-call review.
import Anthropic from "@anthropic-ai/sdk";

let client;
const anthropic = () => (client ??= new Anthropic());

const SYSTEM = `You are a live call coach whispering in the user's ear during a real conversation.
You see the user's private context (who they're talking to, goals, background) and the rolling transcript.
"ME" is the user. "THEM" is the other side. Transcripts are auto-generated: expect errors, fragments, and misattributed words.

Your job, every time you're called: tell the user the single most useful thing to do NEXT, plus a few sharp follow-up questions grounded in what was JUST said.
Rules:
- Be specific to the transcript. Quote or reference their exact words. Generic advice ("ask about challenges") is useless.
- Questions must be short enough to read in 2 seconds and say out loud naturally.
- Loose ends = things THEM mentioned (numbers, names, pains, tools, priorities, hesitations) that ME never followed up on, plus open threads ME promised to address.
- "covered" tracks which of the user's stated goals/talking points have already been hit, so they don't repeat.
- "watch" is a candid warning only if warranted (ME rambling, didn't actually answer the question, stated a guess as a fact, interrupted, missed a buying signal, time running low). Otherwise "".
- If the call is just starting or there's little transcript, lean on the context to suggest a strong opener.`;

// Learning style: THEM knows more about the topic, ME is there to learn it and to build the habit of asking good questions.
const SYSTEM_LEARN = `You are a live learning coach in the user's ear during a real conversation where THEM knows more about the topic and ME is there to learn.
You see the user's private context (who they're talking to, what they want to understand, habits to practice) and the rolling transcript.
"ME" is the user. "THEM" is the other side. Transcripts are auto-generated: expect errors, fragments, and misattributed words.

The goal is not to get through the topic in order. It's for ME to understand it deeply and to build the habit of asking good questions instead of thinking linearly.
Every time you're called: tell the user the question habit to use NEXT, plus a few questions grounded in what THEM JUST said.
Rules:
- Ground every question in THEM's exact words: a term they used, a claim, a number, a step they skipped. Generic questions ("can you say more?") are useless.
- Mix the kinds: clarify a term, ask why (why this and not that), ask for a concrete example or number, ask what breaks or what the tradeoff is, connect it to something ME already knows, play it back in ME's words to check.
- Prefer questions that go deeper or sideways over "and then what" questions that only move forward.
- Open questions, short enough to read in 2 seconds and say out loud naturally. Each "why" says what the question gets ME.
- "now" is the habit to use right now, e.g. "Ask why before they move on to sharding."
- Loose ends = terms, claims, numbers or ideas THEM mentioned that ME hasn't asked about yet.
- "covered" tracks which of the user's learning goals or habits ME has already done on this call.
- "watch" is a candid warning only if warranted (ME nodding along without checking understanding, asking yes/no questions, only asking what comes next, talking more than learning, a playback that got it wrong). Otherwise "".
- If the call is just starting or there's little transcript, suggest an opener that says what ME wants to learn and what ME already knows.`;

const SCHEMA = {
  type: "object",
  properties: {
    now: { type: "string", description: "The single most important nudge right now, <=15 words" },
    ask: {
      type: "array",
      items: {
        type: "object",
        properties: { q: { type: "string" }, why: { type: "string" } },
        required: ["q", "why"],
        additionalProperties: false,
      },
    },
    loose_ends: { type: "array", items: { type: "string" } },
    covered: { type: "array", items: { type: "string" } },
    watch: { type: "string" },
  },
  required: ["now", "ask", "loose_ends", "covered", "watch"],
  additionalProperties: false,
};

const parse = (res) => {
  if (res.stop_reason === "refusal") throw new Error("Claude declined this one");
  const text = res.content.find((b) => b.type === "text")?.text;
  let out; try { out = JSON.parse(text) } catch { throw new Error(`reply was cut off (${res.stop_reason})`) }
  // which model answered and how many tokens, for the page's AI activity log (the page removes it before use)
  return { ...out, _meta: { model: res.model, in: res.usage?.input_tokens ?? null, out: res.usage?.output_tokens ?? null } };
};
const wrap = (context, transcript, empty) =>
  `<context>\n${context || "(none)"}\n</context>\n\n<transcript>\n${transcript || empty}\n</transcript>`;

const learning = (mode) => mode === "learning";
export async function coach({ context, transcript, mode }) {
  return parse(await anthropic().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: learning(mode) ? SYSTEM_LEARN : SYSTEM,
    messages: [{ role: "user", content: `${wrap(context, transcript, "(call hasn't started yet)")}\n\nCoach me for the next 30 seconds. Max 3 questions.` }],
  }));
}

// Fast lane: tiny read of where the call is, refreshed after every finished line.
const PHASES = ["opener", "rapport", "discovery", "pitch", "objection", "closing", "wrap-up"];
const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string", enum: PHASES },
    temperature: { type: "string", enum: ["cold", "neutral", "warm", "hot"] },
    they_care_about: { type: "string", description: "What THEM is optimizing for, in their words, <=12 words" },
    play: { type: "string", description: "The move to make in the next 15 seconds, <=12 words" },
    avoid: { type: "string", description: "One thing NOT to do right now, <=10 words, or empty" },
  },
  required: ["phase", "temperature", "they_care_about", "play", "avoid"],
  additionalProperties: false,
};
const LEARN_PHASES = ["orient", "explain", "probe", "example", "apply", "recap"];
const STRATEGY_LEARN_SCHEMA = {
  ...STRATEGY_SCHEMA,
  properties: {
    ...STRATEGY_SCHEMA.properties,
    phase: { type: "string", enum: LEARN_PHASES, description: "orient = setting up what to learn, explain = THEM explaining, probe = ME asking follow-ups, example = working a concrete case, apply = ME trying it or playing it back, recap" },
    temperature: { type: "string", enum: ["cold", "neutral", "warm", "hot"], description: "How engaged THEM is in teaching" },
    they_care_about: { type: "string", description: "The core idea THEM is explaining right now, <=12 words" },
    play: { type: "string", description: "The question move ME should make in the next 15 seconds, <=12 words" },
  },
};
export async function strategy({ context, transcript, mode }) {
  return parse(await anthropic().messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 1500,
    output_config: { effort: "low", format: { type: "json_schema", schema: learning(mode) ? STRATEGY_LEARN_SCHEMA : STRATEGY_SCHEMA } },
    system: learning(mode)
      ? "You read a live learning conversation and call the next question move, like a coach on the sideline. ME is the user and is learning; THEM knows more. Weight the LAST few lines most: react to what just happened. Push ME to go deeper or sideways, not just forward. Be concrete and terse."
      : "You read a live conversation and call the play, like a coach on the sideline. ME is the user, THEM is the other side. Weight the LAST few lines most: react to what just happened. Be concrete and terse.",
    messages: [{ role: "user", content: wrap(context, transcript, "(not started)") }],
  }));
}

// After the call: one QA pass over the whole transcript. Lines are numbered so misses can link back.
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What happened on the call and where it ended, 2-3 sentences" },
    went_well: { type: "array", items: { type: "string" }, description: "2-4 specific things ME did well, with the moment" },
    misses: {
      type: "array",
      description: "The 2-5 moments that cost ME the most, in call order",
      items: {
        type: "object",
        properties: {
          line: { type: "integer", description: "Line number from the transcript where it happened" },
          what: { type: "string", description: "What ME did, <=20 words" },
          better: { type: "string", description: "What to say or do instead, <=25 words" },
        },
        required: ["line", "what", "better"],
        additionalProperties: false,
      },
    },
    next_step: { type: "string", description: "The agreed next step, or 'None agreed' plus what ME should propose" },
    follow_up_email: {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string", description: "Plain text, from ME to THEM, under 120 words, no buzzwords" } },
      required: ["subject", "body"],
      additionalProperties: false,
    },
    crm_notes: { type: "array", items: { type: "string" }, description: "3-6 short CRM note lines: their priorities, concerns, people, timeline, stage" },
    goals: {
      type: "array",
      description: "One entry per goal listed in the context, in the context's order. Empty if the context lists no goals.",
      items: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The goal, shortened to <=8 words" },
          status: { type: "string", enum: ["hit", "partial", "missed"] },
          line: { type: "integer", description: "Line number of the moment that best shows it, or 0 if there is none" },
          evidence: { type: "string", description: "What happened, or what was missing, <=20 words" },
        },
        required: ["goal", "status", "line", "evidence"],
        additionalProperties: false,
      },
    },
    objections: {
      type: "array",
      description: "Each concern, pushback or skeptical question THEM raised, in call order. Empty if none.",
      items: {
        type: "object",
        properties: {
          line: { type: "integer", description: "Line number where THEM raised it" },
          objection: { type: "string", description: "Their concern in a few words, <=12 words" },
          response: { type: "string", description: "How ME answered, <=20 words" },
          outcome: { type: "string", enum: ["handled", "partly", "not_handled"], description: "handled = answered directly and THEM moved on satisfied" },
        },
        required: ["line", "objection", "response", "outcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "went_well", "misses", "next_step", "follow_up_email", "crm_notes", "goals", "objections"],
  additionalProperties: false,
};
// The recap keeps the same fields in Learning style so the page and the Scorecard stay the same; the descriptions change what goes in them.
const describe = (schema, d) => {
  const out = structuredClone(schema);
  for (const [k, v] of Object.entries(d)) out.properties[k].description = v;
  out.properties.misses.items.properties.what.description = "What THEM said that ME let pass, <=20 words";
  out.properties.misses.items.properties.better.description = "The question ME should have asked, <=25 words";
  out.properties.objections.items.properties.objection.description = "The question ME asked, <=12 words";
  out.properties.objections.items.properties.response.description = "How THEM answered, <=20 words";
  out.properties.objections.items.properties.outcome.description = "handled = clear answer, partly = some of it, not_handled = left open or ME moved on";
  return out;
};
const REVIEW_LEARN_SCHEMA = describe(REVIEW_SCHEMA, {
  summary: "What was covered and how well ME seems to understand it, 2-3 sentences",
  went_well: "2-4 good questions or moments of learning from ME, with the moment",
  misses: "The 2-5 moments where ME let something pass that deserved a question, in call order",
  next_step: "What ME should read, try or ask next to keep learning",
  follow_up_email: "A short thank-you from ME to THEM with one or two follow-up questions",
  crm_notes: "3-6 short notes of what ME learned, in plain words",
  objections: "Each question ME asked, in call order. Empty if ME asked none.",
});
export async function review({ context, lines, mode }) {
  const transcript = (lines || []).map((l, i) => `[${i + 1}] ${l.who.toUpperCase()}: ${l.text}`).join("\n");
  if (!transcript) throw Object.assign(new Error("nothing to review yet"), { status: 400 });
  return parse(await anthropic().beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: learning(mode) ? REVIEW_LEARN_SCHEMA : REVIEW_SCHEMA } },
    system: learning(mode) ? `You review a finished learning conversation. THEM knows more about the topic; ME was there to learn it and to practice asking good questions.
Be honest and specific: point to exact moments. Judge ME against the goals and habits in the context when there are any.
Score goals strictly: "hit" only when the transcript clearly shows it. Credit questions that went deeper or sideways (why, example, what breaks, tradeoff, connection, playback) over ones that only moved forward.
Don't invent facts that aren't in the transcript or context. Transcripts are auto-generated, so ignore obvious transcription noise.
Write plainly: no buzzwords, no em-dashes.` : `You are a call QA reviewer. You read a finished call between ME (the user) and THEM and write the recap a sales manager would want.
Be honest and specific: quote or point to exact moments. Judge ME against the goals in the context when there are any.
Score goals strictly: "hit" only when the transcript clearly shows it. Count an objection only when THEM pushed back or doubted something, not for neutral questions.
Don't invent facts that aren't in the transcript or context. Transcripts are auto-generated, so ignore obvious transcription noise.
Write plainly: no buzzwords, no em-dashes.`,
    messages: [{ role: "user", content: `${wrap(context, transcript.slice(-120000), "")}\n\nWrite the post-call recap.` }],
  }));
}
