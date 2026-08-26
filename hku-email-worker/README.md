# hku-email-worker

Cloudflare Worker that bridges **Resend inbound email → Gemini 1.5 Flash → Firebase RTDB tasks and events**.

## How it works

1. You forward an email to `hku@seluesilun.resend.app`
2. Resend fires an `email.received` webhook to this Worker
3. Worker fetches the full email body via Resend API
4. Gemini extracts a structured task and/or event (or returns null if neither is present — an email can yield a task only, an event only, both, or neither)
5. Task (if any) is written to Firebase `/todos`, event (if any) to `/events` — both appear instantly in hkub.html

## Files

| File | Purpose |
|---|---|
| `worker.js` | Main Worker logic |
| `wrangler.toml` | Cloudflare config |
| `package.json` | Dev dependency (wrangler) |

## Deploy

### 1. Set secrets

```bash
wrangler secret put RESEND_API_KEY
# paste: re_xxxxxxxxx (Resend Dashboard → API Keys)

wrangler secret put RESEND_WEBHOOK_SECRET
# paste: whsec_xxxxxxxxx (Resend Dashboard → Webhooks → signing secret)

wrangler secret put GEMINI_API_KEY
# paste: AIzaSy... (aistudio.google.com → Get API Key)

wrangler secret put FIREBASE_SECRET
# paste: your Firebase RTDB legacy secret
# (Firebase Console → Project Settings → Service Accounts → Database secrets)
```

### 2. Deploy

```bash
cd hku-email-worker
npm install      # installs wrangler locally
wrangler deploy
```

Copy the Worker URL it prints: `https://hku-email-worker.YOUR.workers.dev`

### 3. Create Resend webhook

- Resend Dashboard → **Webhooks** → **Add Endpoint**
- URL: paste your Worker URL
- Events: check **`email.received`**
- Save → copy the **Signing Secret** → paste into `wrangler secret put RESEND_WEBHOOK_SECRET`

### 4. Test

Forward any email to `hku@seluesilun.resend.app`.
Check Worker logs: `wrangler tail`
Check Firebase: open hkub.html → Tasks tab and Events tab.

## Firebase config (already in worker.js)

```
URL:     https://adip-hku-default-rtdb.asia-southeast1.firebasedatabase.app
Project: adip-hku
```

## Courses Gemini knows about

`Pyth` `AAI` `GAI` `BC` `MAIB7001` `MAIB7002` `MAIB7003` `MAIB7005` `MAIB7011` `MAIB7012` `MAIB7013` `MAIB7008` `MAIB7009` `MAIB7007` `MAIB7901` `LLAW6334` `MAIB7014` `MAIB7010`

(kept in sync with the `COURSES` object in `hkub.html`; used for tagging both a task's `course` and an event's `course` field)
