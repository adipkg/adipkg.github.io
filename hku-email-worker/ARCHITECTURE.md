# How hku-email-worker works

A walkthrough of the system end-to-end, for future-me (or anyone else)
picking this back up later.

## The big picture

```
  You forward an email
          │
          ▼
  hku@seluesilun.resend.app   (Resend inbound address)
          │  Resend receives + parses the email
          ▼
  Resend fires "email.received" webhook  ──POST──▶  Cloudflare Worker
          │                                          (hku-email-worker)
          │                                                │
          │                                    1. verify webhook signature
          │                                    2. fetch full email body
          │                                       (Resend Receiving API)
          │                                    3. ask Gemini to extract a task
          │                                    4. write task to Firebase
          ▼                                                │
   (Resend just delivers metadata                          ▼
    in the webhook itself — the                  Firebase RTDB `/todos`
    body is fetched separately)                            │
                                                             ▼
                                              hkub.html Tasks tab
                                          (onValue listener, live update)
```

Everything lives in one file, `worker.js`, deployed as a single Cloudflare
Worker with no persistent state of its own — it's a pure request handler.

## Step by step

### 1. Inbound address → Resend

`hku@seluesilun.resend.app` is a Resend-managed inbound address (their
`.resend.app` receiving domain, not a real mailbox). Any email forwarded
there is received and parsed by Resend, not by this Worker directly.

### 2. Webhook delivery

Resend is configured (Resend Dashboard → Webhooks) to POST an
`email.received` event to the Worker's URL for every inbound email. The
webhook payload is **metadata only** — sender, subject, an `email_id` — it
deliberately does **not** include the body, to keep webhook payloads small.

### 3. Signature verification (`verifySignature`)

Resend signs webhooks using the [Svix](https://www.svix.com) format so the
Worker can trust that a request really came from Resend and hasn't been
tampered with or replayed:

- Headers `svix-id`, `svix-timestamp`, `svix-signature` arrive with the request.
- The Worker rejects anything with a timestamp more than 5 minutes old
  (replay protection).
- It recomputes an HMAC-SHA256 over `"{svix-id}.{svix-timestamp}.{body}"`
  using the webhook signing secret as the key, and checks it matches one of
  the space-separated signatures in `svix-signature`.
- **Gotcha:** the signing secret is `whsec_<base64>` — the actual HMAC key is
  the base64-decoded bytes *after* stripping `whsec_`, not the secret string
  itself. See `TROUBLESHOOTING.md` for the bug this caused.

If verification fails, the Worker returns `401` and stops — nothing downstream
runs.

### 4. Fetching the full email (`GET /emails/receiving/{email_id}`)

The webhook only gave us an `email_id`, so the Worker calls Resend's
Receiving API to get the actual content:
```
GET https://api.resend.com/emails/receiving/{email_id}
Authorization: Bearer <RESEND_API_KEY>
```
This returns the email's `text` and `html` bodies. The Worker prefers
`text`; if only `html` is present, it strips tags with a regex and collapses
whitespace as a fallback.

### 5. Task extraction (`geminiExtract`)

The subject + sender + body (truncated to 4000 chars) are sent to
**Gemini 2.5 Flash** with a prompt that asks it to:
- Decide if the email is actually actionable (skip newsletters, marketing,
  FYI notifications — return the literal string `null` for those).
- If actionable, return strict JSON matching the app's task shape:
  ```json
  {
    "text": "short task description",
    "due": "YYYY-MM-DD or null",
    "priority": "high | medium | low",
    "course": "one of the known course codes, or null",
    "done": false,
    "createdAt": <epoch ms>,
    "source": "email"
  }
  ```
- `responseMimeType: 'application/json'` + `temperature: 0.1` push Gemini
  toward returning clean, deterministic JSON. The Worker still defensively
  strips ``` markdown fences and re-checks for a literal `null` before
  parsing, in case Gemini doesn't fully honor the JSON-mode request.
- The known course codes (`COURSE_CODES`) are injected into the prompt so
  Gemini only ever tags a course that actually exists in `hkub.html`'s
  `COURSES` object — these two lists must be kept in sync manually.

If Gemini decides the email isn't a task, the Worker just returns `200 ok`
with nothing written anywhere — this is expected/normal behavior, not a bug.

### 6. Writing to Firebase

The extracted task object is `POST`ed as-is to:
```
https://adip-hku-default-rtdb.asia-southeast1.firebasedatabase.app/todos.json?auth=<FIREBASE_SECRET>
```
Firebase RTDB's REST semantics: a `POST` to a `.json` path is equivalent to
`push()` — it generates a new unique child key under `/todos` and stores the
task there. This is the **same** `/todos` path and the same Firebase project
(`adip-hku`) that `hkub.html` reads from via the Firebase JS SDK's
`onValue(todosRef, ...)` listener, so the new task shows up in the Tasks tab
essentially instantly with no polling or manual refresh needed.

### 7. Response codes back to Resend

The Worker always returns `200 ok` for anything it can recover from (fetch
failures, Gemini errors, non-actionable emails) — this tells Resend
"delivered successfully, don't retry." It only returns non-200 for:
- `405` — wrong HTTP method.
- `401` — signature verification failed.
- `400` — unparseable webhook body.
- `500` — the Firebase write itself failed (this *is* worth Resend retrying).

## Why it's split this way (webhook metadata vs. separate body fetch)

Resend's webhook is intentionally lightweight (metadata + `email_id` only).
Full bodies, especially with attachments, can be large — Resend makes you
pull the body on demand via the Receiving API instead of pushing it in the
webhook payload. That's why the Worker needs both `RESEND_API_KEY` (to pull
the body) and `RESEND_WEBHOOK_SECRET` (to verify the webhook itself) — two
different credentials for two different purposes.

## Secrets summary

| Secret | Used for | Where it comes from |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | Verifying the inbound webhook is really from Resend | Resend Dashboard → Webhooks → signing secret |
| `RESEND_API_KEY` | Pulling the full email body after the webhook fires | Resend Dashboard → API Keys |
| `GEMINI_API_KEY` | Calling Gemini to extract the task | aistudio.google.com |
| `FIREBASE_SECRET` | Authenticating the write to Firebase RTDB | Firebase Console → Project Settings → Service Accounts → Database secrets (legacy secret, not a service account JSON key) |

None of these are in the repo — all four are Worker secrets set via
`wrangler secret put` (see `README.md`).
