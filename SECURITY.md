# Security notes

This is a demo for one user, not a product. What it does and what it would need before real customers use it.

## What's in place

- **App access:** one shared passcode (`APP_PASSCODE`). A correct passcode sets a signed, HttpOnly, Secure, SameSite=Lax cookie for 30 days. 10 wrong tries lock login for 15 minutes. The cookie signing key is `SESSION_SECRET` if set, otherwise derived (scrypt) from the passcode and the server-only Blob token, so changing the passcode signs everyone out.
- **API keys:** OpenAI and Anthropic keys stay in server env vars. The browser gets a 10-minute OpenAI key scoped to one transcription session per lane.
- **Recaps:** random 96-bit id in the URL plus an 8-character code (about 40 bits). Only a salted scrypt hash of the code is stored. A correct code sets a cookie that only works for that recap's path, for 14 days. 5 wrong codes lock that recap for 15 minutes. Recaps expire after 14 days. Revoke deletes the recap. The call context box is never copied into a recap.
- **Storage:** sessions and recaps sit in a private Vercel Blob store, read only by the server.
- **How pages are served:** every HTML response has a Content-Security-Policy with a per-response nonce, so only the app's own scripts run. The browser can only connect to this site and OpenAI's realtime socket. Pages can't be framed. Nothing is cached or indexed, and no referrer is sent. HSTS and a Permissions-Policy limited to microphone and screen capture are set.
- **Writes:** POSTs from another origin are rejected, on top of the SameSite cookie.
- **Output:** transcript and model text is escaped before it goes into a page, and inlined JSON escapes `<`.

## Known gaps before this could be a product

- **One shared passcode, no user accounts.** Needs real auth (SSO or magic link), per-user roles and per-org data separation.
- **Login lock is global.** Someone guessing passcodes can lock the real user out for 15 minutes. Needs per-IP or per-account limits, ideally at the edge (Vercel Firewall rate limiting).
- **No spending limits.** A signed-in user can call Claude and OpenAI as often as they like. Needs per-user rate limits and budget alerts.
- **Lock counters are read-modify-write on Blob.** Parallel guesses can slip a few extra tries past the limit. A store with atomic increments (Redis, Postgres) fixes it.
- **Recap codes are short on purpose** so they're easy to send. For sensitive calls, use longer codes or require the viewer's email (magic link).
- **Recap expiry is checked on read.** Recaps stop opening after 14 days and are deleted when someone tries, but an unopened expired recap stays in storage until then. A scheduled cleanup job would remove them.
- **No audit log** of who opened a recap or when.
- **Transcripts are stored as plain JSON.** Vercel encrypts Blob storage at rest, but there's no app-level encryption, retention policy or delete-my-data flow.
- **Call consent.** The app records the other side of the call. A product needs a consent notice and has to follow two-party consent laws.
- **Third parties.** Audio goes to OpenAI and transcripts go to Anthropic. A product needs data processing agreements, zero-retention settings where offered, and a subprocessor list.
- **Prompt injection.** Whatever is said on a call goes into Claude prompts. Output is only ever displayed and escaped, never executed, so the impact is limited to wrong coaching text.
- **Google Fonts** loads from Google's servers. Self-host the fonts to drop that request.
- **Preview deployments** are behind Vercel Authentication. Shared recap links need to come from the production URL.
