# Co-Create: SHEIN GenAI personalisation demo (MAIB7003, Stream 2)

Live at **https://adipkg.github.io/shein/**. Plain HTML/CSS/JS on GitHub Pages. Data lives under `shein/` in the `adip-hku` Firebase Realtime Database, and AI calls go through the Cloudflare Worker `shein-cocreate-worker`, which holds the keys.

| Page | What it shows | Stream 2 task |
|---|---|---|
| `index.html` | Username, consent and value exchange, power/dormant segment | B1 |
| `swipe.html` | 20-card onboarding swipe, then the endless **lo-fi** deck: Jev-designed garments rendered in three.js | B1, B2, B3, B4 |
| `social.html` | Social Sync (Option A): upload inspiration images, which Gemini maps to catalogue attributes | B1 |
| `hifi.html` | **Hi-fi**: same Jev spec, rendered photoreal by an HKU image model, Jev-screened, human-reviewed | B2, B3 |
| `profile.html` | One shopper's 60/30/10 taste blend, history, orders, privacy controls | B1, D5 |
| `dashboard.html` | Trends, cohorts (k-means + PCA), pilot segments, Jev calibration, guardrails, inventory, model A/B, review queue, escalations | B2–B4, C2, D6, D8 |

## Look and feel
The app is black and white, with matte frosted-glass cards (`backdrop-filter` blur plus a faint grain) over a woven-canvas background (`assets/fabric.jpg`). The SHEIN wordmark sits with an italic "co·create". The fonts are Fraunces for display and Inter for UI. Buttons follow SHEIN's retail style: square, uppercase and tracked.
- **Single light theme**: there is no dark mode, because the white canvas is part of the identity.
- **Colour-free states**: like, pass and order are shown by icon, fill and position. Guardrail pass/fail uses outline vs solid pills.
- **Colour-free cohorts**: on the dashboard, cohorts differ by shade and point shape.
- **Disclaimer**: the footer disclaimer must stay, because the SHEIN name is used.

## How a design is made
1. **Taste**: every swipe updates a weight for each catalogue attribute (block, fabric, colour, print, fit).
2. **Blend**: 60% the shopper's own weights, 30% creator looks (`data/kol.json`), 10% live trend counters.
3. **Jev** (TypeSafe System One, `jev-latest`) returns a probability for every catalogue option, and specs are sampled from those probabilities.
4. **Guardrails** (`js/guardrails.js`):
   - (1) master pattern block + compatible fabric
   - (2) fabric in stock (live RTDB inventory)
   - (3) SUCP ≤ 18% and ≤ 7 days
   - (4) IP risk ≤ 35% (Jev `noul`; on the real image pixels for hi-fi)
5. **Swipe**: ← nope, → like, ↑ order. An order creates a single-unit work order and draws down fabric stock.
6. **Escalation**: when likes + 3×orders ≥ 6, the design is queued for an LATR micro-batch and shown to shoppers with similar taste.

## Run locally
```bash
# 1. static site
python3 -m http.server 5173 --bind 127.0.0.1        # open http://127.0.0.1:5173
# 2. worker (needs worker/.dev.vars with JEV_API_KEY and HKU_API_KEY)
cd worker && wrangler dev --port 8787
```
Set `FIREBASE_CONFIG` in `js/config.js` to `null` to keep data in the browser instead (localStorage, one device).

## Deploy
- **Site**: GitHub Pages serves this folder from the `adipkg.github.io` repo; push to `main` to deploy.
- **Data**: the `adip-hku` Realtime Database, under `shein/` (live paths) and `shein/docs/` (document collections). No Firestore.
- **Worker**: from `worker/`, run `wrangler deploy`. Secrets are set with `wrangler secret put` for JEV_API_KEY, HKU_API_KEY and DEMO_PASSCODE. Only https://adipkg.github.io and localhost may call it. The passcode gates the HKU routes (`/gemini`, `/image`); Jev stays open for the swipe feed.
- **Local dev**: `python3 -m http.server`, plus `wrangler dev --port 8787` in `worker/` (needs `worker/.dev.vars`).

## Limits to know before the pitch
- **HKU image quota**: `gemini-2.5-flash-image` allows 2/min and 70/week; `gemini-3.1-flash-image` allows 2/min and 35/week. The quota is shared with the HKU GenAI app. Generate a library ahead of time and approve it on the dashboard.
- **gpt-image-1.5** is not in the HKU portal docs yet. `/openai-image` in the worker returns 501 until it is wired up.
- **Gemini text** allows 3/min and 300/day. It is used only for Social Sync and cohort naming, never per swipe.
- **Jev image input** is experimental (`TypeSafe-Danger-Zone-Images` header, 512×512 JPEG).
- **Prompt wording**: image prompts must not mention watermarks. The model treats "no watermark" as a watermark-removal request and blocks it.
- **No auth**: `shein/` must be publicly writable. Lock it after the pitch.
- **Synthetic shoppers**: the dashboard's "+24 synthetic shoppers" records are flagged `synthetic` and can be removed in one click. Say so if you show them.
