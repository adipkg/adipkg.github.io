# Troubleshooting hku-email-worker

Notes from debugging the worker when forwarded emails weren't showing up as
tasks in `hkub.html`. Read this before re-debugging from scratch.

## How to debug

1. Tail live logs in one terminal:
   ```bash
   cd hku-email-worker
   wrangler tail --format pretty
   ```
2. Forward a test email to `hku@seluesilun.resend.app`.
3. Watch the log line-by-line — the worker logs at each stage (received,
   signature check, Resend fetch, Gemini call, Firebase write), so the log
   tells you exactly which step failed.

Also useful:
- `wrangler secret list` — confirms all 4 secrets are set (does not show values).
- `wrangler deployments list` — confirms the latest code is actually live.

## Known past bugs (fixed)

### 1. `(error) Signature verification failed` on every request

**Cause:** Resend's webhook signing secret is Svix-formatted: `whsec_<base64>`.
The HMAC key is the **base64-decoded bytes after the `whsec_` prefix** — not
the raw secret string. The original code did:
```js
new TextEncoder().encode(secret) // wrong — encodes "whsec_..." as literal text
```
which can never match Resend's computed signature.

**Fix:** strip the prefix and base64-decode before importing as the HMAC key:
```js
const secretBytes = Uint8Array.from(atob(secret.split('_')[1] || secret), c => c.charCodeAt(0));
```

If you ever regenerate `RESEND_WEBHOOK_SECRET` in the Resend dashboard, this
logic doesn't need to change — just re-run `wrangler secret put RESEND_WEBHOOK_SECRET`
with the new value.

### 2. `(error) Failed to fetch email body: Resend API 405`

**Cause:** wrong endpoint. The code called `GET /emails/{id}/content`, which
doesn't exist (405 Method Not Allowed). The correct Resend endpoint for a
**received** email's full body is:
```
GET https://api.resend.com/emails/receiving/{email_id}
```
(Resend's `/emails/{id}` family without `/receiving/` is for emails *you sent*,
not inbound ones.)

## Other things worth checking if it breaks again

- **Course tagging wrong/missing**: `COURSE_CODES` in `worker.js` must be kept
  in sync with the `COURSES` object in `hkub.html`. If a new module's course
  codes are added to `hkub.html`, add them here too (and in the README).
- **Gemini returns `null` for real tasks**: check the raw Gemini response in
  `wrangler tail` — the prompt asks for strict JSON or the literal word
  `null`; if Gemini wraps output in markdown fences the code strips them, but
  a genuinely malformed response will log `Gemini returned invalid JSON: ...`.
- **Webhook never arrives at all**: check Resend Dashboard → Webhooks → the
  endpoint's recent delivery attempts/response codes before assuming the
  Worker is broken — confirms whether Resend even reached Cloudflare.
- **Firebase write fails**: `FIREBASE_SECRET` is the RTDB *legacy* secret
  (Project Settings → Service Accounts → Database secrets), not a service
  account JSON key — a common mix-up.
