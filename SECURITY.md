# Security notes

This is a demo, not a product. What it does and what it would need before real customers use it.

## What's in place

- **No sign-in, no stored calls.** Anyone with the URL can use the app. Audio, transcript, context and recaps stay in the browser. History is in IndexedDB on that computer.
- **No AI keys.** Speech to text and the coach model run in the browser, so nothing is sent to an AI service and there is nothing to spend.
- **Recaps:** "Download recap" posts the call to `/api/recap-file`, which builds one HTML file and returns it as a download. Nothing is written to storage. The body is capped at 5 MB, only the transcript, coach history and recap fields are kept, and the call context box is dropped.
- **Older shared links:** recaps shared by an earlier version (`/r/<id>`) open only with their code, never without it. A correct code sets a cookie for that recap's path for 14 days; 5 wrong codes lock it for 15 minutes. Only the browser that shared a recap can list or revoke it. Recaps with no owner are never listed.
- **How pages are served:** every HTML response has a Content-Security-Policy with a per-response nonce, so only the app's own scripts run. The page can only connect to this site. Pages can't be framed. Nothing is cached or indexed, and no referrer is sent. HSTS and a Permissions-Policy limited to microphone and screen capture are set.
- **Writes:** POSTs from another origin are rejected.
- **Output:** transcript and model text is escaped before it goes into a page, and inlined JSON escapes `<`.
- **Workers:** the two AI workers have their own CSP: they may download model files from Hugging Face (and, for Qwen, WebLLM's model library from raw.githubusercontent.com) and nothing else. All scripts, including ONNX Runtime's wasm, are bundled at build time and served by this app at pinned versions; no CDN code runs. The speech worker needs `'unsafe-eval'` because ONNX Runtime's Emscripten bindings build functions at runtime; it has no access to the page or cookies.

## Known gaps before this could be a product

- **The app is open.** That's fine while it stores nothing and calls no paid service. Adding either would need accounts, per-user rate limits and budget alerts.
- **Downloaded recaps are plain files.** Whoever has the file can read it. Sensitive calls need a shared link with access control instead.
- **Model weights** are trusted as downloaded from Hugging Face over HTTPS, without our own hash check.
- **Call consent.** The app records the other side of the call. A product needs a consent notice and has to follow two-party consent laws.
- **Prompt injection.** Whatever is said on a call goes into the local model's prompt. Output is only ever displayed and escaped, never executed, so the impact is limited to wrong coaching text.
- **Google Fonts** loads from Google's servers. Self-host the fonts to drop that request.
