# Co-Create: SHEIN GenAI personalisation demo (MAIB7003, Stream 2)

Live at **https://adipkg.github.io/shein/**. Plain HTML/CSS/JS on GitHub Pages. Data lives under `shein/` in the `adip-hku` Firebase Realtime Database, and AI calls go through the Cloudflare Worker `shein-cocreate-worker`, which holds the keys.

| Page | What it shows | Stream 2 task |
|---|---|---|
| `index.html` | Username → existing or new customer → demo order history (existing) → gender & occasions → consent → optional "on me" photo | B1 |
| `social.html` | Share socials (simulated connect): creators, films, aesthetics, liked posts → Gemini maps them to the catalogue | B1 |
| `swipe.html` | 12-card onboarding deck (filtered by gender/occasion), then the endless **lo-fi** deck: Jev designs rendered in three.js | B1–B4 |
| `foryou.html` | **Made for you**: curated rows (best matches, bought by your cohort, trending in your style, something new, real-life looks, on you) with like/pass on every tile, details, order and **See it for real** | B2, B3 |
| `profile.html` | What shapes your designs (signal sources), 60/30/10 taste, past purchases, socials, photo & private looks, orders, privacy | B1, D5 |
| `dashboard.html` | Trends, persistent cohorts, existing vs new, signal mix, exploration slider + metrics, cohort sharing funnel, audience, Jev calibration, guardrails, hi-fi, review queue, escalations | B2–B4, C2, D6, D8 |

## Look and feel
The app is black and white, with matte frosted-glass cards (`backdrop-filter` blur plus a faint grain) over a woven-canvas background (`assets/fabric.jpg`). The SHEIN wordmark sits with an italic "co·create". The fonts are Fraunces for display and Inter for UI. Buttons follow SHEIN's retail style: square, uppercase and tracked.
- **Single light theme**: there is no dark mode, because the white canvas is part of the identity.
- **Colour-free states**: like, pass and order are shown by icon, fill and position. Guardrail pass/fail uses outline vs solid pills.
- **Colour-free cohorts**: on the dashboard, cohorts differ by shade and point shape.
- **Disclaimer**: the footer disclaimer must stay, because the SHEIN name is used.

## How a design is made
1. **Signals, weighted:** purchase 5 · order 4 · social 1.5 · like 1 · answers 0.6 · cohort prior 0.4 · dwell 0.3 · pass −0.7. Each source is kept separately (`bySource`), and every new signal fades the old ones a little (×0.985), so the profile keeps up with the shopper.
2. **Cold start:**
   - Existing customers start from their order history; older orders count less.
   - New customers start from their answers plus a softened copy of the nearest cohort's taste.
3. **Jev** gives a probability for every catalogue option, from the 60/30/10 blend, purchases, socials, occasions and recent reactions.
4. **Exploration vs exploitation:**
   - Each option is scored as Jev probability^0.6 × Thompson sample × novelty. The Thompson sample is a plausible like-rate drawn from that option's evidence, so rarely-seen options get a fair chance.
   - Each batch is a slate of best matches, one twist (1–2 attributes changed) and discovery. The dashboard slider sets the mix.
   - Within a batch, every pick pushes the next one away from the attributes just used.
5. **Guardrails:** (1) master pattern block + compatible fabric, (2) live fabric stock, (3) SUCP ≤ 18% and ≤ 7 days, (4) Jev IP check, run on the image pixels for hi-fi.
6. **Cohorts:**
   - Persistent: k-means on unit taste vectors, recomputed automatically, with ids and names kept across recomputes.
   - A purchase goes straight into the buyer's cohort pool, and other members see "Bought by N people with your taste".
   - Designs with a trend score ≥ 8 escalate to an LATR micro-batch.
7. **See it for real:**
   - *On a model*: shared, cached per design, Jev-screened, and held for human review.
   - *On me*: the onboarding photo is edited to wear the design. The photo and result stay in the browser only.
   - Each shopper gets 3 renders a day; cache hits are free.

## Run locally
Set `localStorage.sd_db = 'local'` in the browser to use the in-browser database instead of Firebase (offline fallback; tests).

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
- **HKU AI credits**: the gateway answers "Insufficient token." when the account's image credits run out (shared with the HKU GenAI app); the app then shows a clear message. "On me" edits send the photo as `inlineData` (Gemini's documented edit format) and haven't been verified live yet, because credits ran out during testing.
- **gpt-image-1.5** is not in the HKU portal docs yet. `/openai-image` in the worker returns 501 until it is wired up.
- **Gemini text** allows 3/min and 300/day. It is used only for Social Sync and cohort naming, never per swipe.
- **Jev image input** is experimental (`TypeSafe-Danger-Zone-Images` header, 512×512 JPEG).
- **Prompt wording**: image prompts must not mention watermarks. The model treats "no watermark" as a watermark-removal request and blocks it.
- **No auth**: `shein/` must be publicly writable. Lock it after the pitch.
- **Synthetic shoppers**: the dashboard's "+24 synthetic shoppers" records are flagged `synthetic` and can be removed in one click. Say so if you show them.
