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
   tells you exactly which step failed. Since the worker can extract a task
   **and** an event from the same email, you may see up to two separate
   "written to Firebase" lines per email — one for the task, one for the
   event — or just one if only one of them was present.

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

### 3. `SyntaxError: Identifier 'event' has already been declared`

**Cause:** when the dual task+event extraction was added, the destructured
extraction result `const { task, event } = extraction;` collided with an
earlier `let event;` (the parsed webhook payload) already declared in the
same `fetch` function scope. This is a hard parse-time `SyntaxError` in any
JS engine, so it would have broken the Worker entirely on deploy — a plain
`node --check worker.js` did **not** catch it (Node's non-strict/CJS-style
syntax check on a `.js` file without `"type":"module"` doesn't always
re-validate ESM-only redeclaration rules the same way the Workers runtime
does). If you need to sanity-check syntax again, force ESM parsing:
```bash
node --input-type=module --check < worker.js
```

**Fix:** the outer webhook payload variable was renamed to `webhookEvent`,
leaving `event` free to mean "the extracted calendar event" everywhere else
in the file.

### 4. Duplicate task/event pairs from the same email

**Cause:** Resend redelivered the same `email.received` webhook (same
`email_id`) roughly 1.5 minutes after the first attempt — most likely
because the Worker's response was slow enough (Resend fetch + Gemini call +
two sequential Firebase writes) to hit Resend's own delivery timeout, even
though the Worker eventually returned `200 ok` both times. Since Gemini
isn't perfectly deterministic, the two extractions differed slightly,
producing two near-duplicate task+event pairs in Firebase instead of an
exact, easy-to-spot dupe.

**Fix:** the Worker now writes `/processedEmails/{email_id}` to Firebase
immediately after reading the webhook payload, *before* doing any of the
slow Gemini/Firebase work, and checks it first — a retry for an `email_id`
already marked processed is skipped with a `200 ok` and a
`Already processed this email_id, skipping` log line. This is a simple
check-then-mark (not a Firebase transaction), so it protects against the
retry timing observed here (minutes apart) but not a true millisecond-level
race between two near-simultaneous requests — not a realistic concern for
this traffic pattern. `/processedEmails` grows one small key per email
forever; that's expected and not worth pruning for personal-project volume.
If you ever see duplicates again, check `wrangler tail` for two log lines
with the same `(id: ...)` and confirm `/processedEmails/{that id}.json`
exists — if it's missing, the dedup check itself failed open (transient
Firebase read error) rather than being genuinely skipped.

## Other things worth checking if it breaks again

- **Course tagging wrong/missing**: `COURSE_CODES` in `worker.js` must be kept
  in sync with the `COURSES` object in `hkub.html`. If a new module's course
  codes are added to `hkub.html`, add them here too (and in the README) — this
  now applies to both `task.course` and `event.course`.
- **Event has garbage/reversed dates**: the UI does not validate `start <= end`
  or date format — if Gemini returns malformed dates the event will render
  oddly (or not at all) on the calendar; check the raw Gemini JSON in
  `wrangler tail`.
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
