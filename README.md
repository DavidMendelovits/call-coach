# Call coach, on-device

Live call coach with no API keys: transcribes both sides of a call, reads the play after every line, coaches you in real time, and writes a recap when you stop, which you can download as one file. Speech to text and the coach model run in the browser. There is no sign-in, and the server stores nothing about your calls. This branch (`in-browser`) deploys as its own Vercel project; `main` is the key-based version.

- **Transcription:** mic (YOU) and a shared tab (THEM) each go through a small voice detector that cuts at 0.7 s pauses. Each utterance is transcribed by Moonshine base (transformers.js, WebGPU or CPU) in a Web Worker. About 155 MB, downloaded once.
- **Strategy, coach and recap:** a local model with JSON-schema output. "Auto" uses Chrome's built-in Gemini Nano when it's already on disk, otherwise Qwen 3.5 2B (4-bit, about 1.3 GB, WebGPU via WebLLM) in a Web Worker. The sidebar can force either.
- **Efficiency readout:** the sidebar shows model size, load time, how far text lags behind speech, how many times faster than real time speech runs, tokens per second, last answer time, the model cache on disk and page memory. `/check` loads and times both models before a call and has a mic test.
- **Scorecard:** a second tab on the recap, in the app and in the downloaded file. Talk ratio, questions asked on each side and your longest turn come from the transcript. Goals from the call context (hit, partly, missed) and each objection with how it was handled come from the recap. Every row jumps to its line.
- **Recaps:** "Download recap" saves the recap, Scorecard and transcript as one HTML file that opens in any browser. The server builds the file and keeps nothing. The call context box is never in it.

## Using it on a call

Use Chrome or Edge on a desktop, with headphones.

- **Google Meet:** open Meet in a Chrome tab. In the coach, set the call context, press Start listening, allow the mic, pick the Meet tab and turn on "Share tab audio".
- **Voice chat with Claude or ChatGPT:** same steps, picking the claude.ai or chatgpt.com tab. Their desktop apps aren't tabs: share the entire screen with system audio instead, or use the web version.
- **Check it's working:** both level meters move, and the status says "you + meeting". "mic only" means the tab audio wasn't shared.
- Safari and Firefox can't share tab audio, so only your side is transcribed there.
- **Before the call:** open "Check this computer" and load the models once, so the first Start doesn't wait on a download.
- **Long calls:** the recap uses the most recent part of the call that fits the local model (about 4,000 words with Qwen) and says so.

## Context, presets and coach styles

The context box (who, goals, facts not to overstate) goes into every coach, strategy and recap call, on this computer. Pick a preset or write your own, then Save it as a preset for next time. Saved presets stay in this browser.

- **Selling:** the sales coach. Phases run opener, rapport, discovery, pitch, objection, closing, wrap-up. The recap covers goals, objections, the next step and a follow-up email.
- **Learning:** for a call where the other person knows more. It pushes clarifying, why, example and tradeoff questions instead of "and then what". Phases run orient, explain, probe, example, apply, recap. The recap lists what you learned, the questions you asked and the ones you missed, and a thank-you note.

Downloaded recaps never include the context box.

## History

Calls are saved in this browser (IndexedDB), with the context and coach style they ran with. There are no accounts, so another browser or computer starts empty, and nothing is kept on the server.

## The live screen

- **Inputs:** one live wave strip for you (mic) and one for them (the shared tab). The mic is picked from the chip next to your strip. "Tab not shared" shows when the meeting tab has no audio.
- **Models:** a signal path from your mic and the tab, to the speech model, to the model that coaches. Each node names the model and where it runs; its light is on while a call is out. Select one to see its calls, with timing and size.
- **Coach me now:** asks for coaching at once instead of waiting for the next line.

## Sharing a recap

Stop the call and press Download recap. Send the file however you like: email, Slack, a shared drive. Anyone can open it in a browser; it needs no account and no connection to this app.

Links shared by an earlier version (`/r/<id>` plus a code) still open with their code until they expire, and the browser that shared one can revoke it from the sidebar.

## Run locally

```
cp .env.example .env   # nothing to set
npm install
npm start              # http://localhost:4777
```

`node report.mjs <session-id>` writes a standalone replay page to `reports/` from a session that an earlier version saved in `./sessions`.

## Deploy to Vercel

1. Import this repo as a new Vercel project with `in-browser` as its production branch. `vercel.json` runs `npm run build` (bundles the workers and copies the ONNX runtime into `public/`) and routes pages to `api/index.mjs`.
2. Settings → Git → Ignored Build Step: `[ "$VERCEL_GIT_COMMIT_REF" != "in-browser" ]`, so pushes to other branches don't build here.
3. No environment variables and no storage are needed. Open the URL and start a call. `/check` tests the browser and loads the models.

See [SECURITY.md](SECURITY.md) for what is and isn't hardened, and `/how-it-works` in the app for the pipeline.

Use headphones on calls, or the other side's voice leaks into your mic and shows up as YOU.
