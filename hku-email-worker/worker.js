/**
 * hku-email-worker
 * ────────────────
 * Receives Resend `email.received` webhooks, fetches the full email body,
 * sends it to Gemini Flash to extract a task and/or an event, and writes
 * each (if present) to the Firebase Realtime Database /todos and /events
 * paths respectively.
 *
 * Required secrets (set via `wrangler secret put`):
 *   RESEND_API_KEY          — re_xxxxxxxx from Resend dashboard
 *   RESEND_WEBHOOK_SECRET   — signing secret from Resend Webhooks dashboard
 *   GEMINI_API_KEY          — from aistudio.google.com
 *   FIREBASE_SECRET         — Firebase RTDB legacy secret
 *                             (Project Settings → Service Accounts → Database Secret)
 *
 * Firebase URL is hardcoded below since it's not sensitive.
 */

const FIREBASE_URL = 'https://adip-hku-default-rtdb.asia-southeast1.firebasedatabase.app';

const COURSE_CODES = [
  'Pyth', 'AAI', 'GAI', 'BC',
  'MAIB7001', 'MAIB7002', 'MAIB7003', 'MAIB7005',
  'MAIB7011', 'MAIB7012', 'MAIB7013',
  'MAIB7008', 'MAIB7009', 'MAIB7007',
  'MAIB7901', 'LLAW6334', 'MAIB7014', 'MAIB7010',
];

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.text();

    // ── 1. Verify Resend webhook signature (svix) ──────────────────────────
    const valid = await verifySignature(request.headers, body, env.RESEND_WEBHOOK_SECRET);
    if (!valid) {
      console.error('Signature verification failed');
      return new Response('Unauthorized', { status: 401 });
    }

    let webhookEvent;
    try {
      webhookEvent = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Only handle inbound emails
    if (webhookEvent.type !== 'email.received') {
      return new Response('ok');
    }

    const { email_id, subject, from } = webhookEvent.data;
    console.log(`Received email: ${subject} from ${from} (id: ${email_id})`);

    // ── Idempotency: Resend may redeliver the same webhook (e.g. if this
    // Worker is slow to respond), which would otherwise create duplicate
    // task/event records. Mark the email_id as processed up front, before
    // the slow Gemini/Firebase work below, so a near-simultaneous retry
    // sees it and skips.
    if (await alreadyProcessed(email_id, env.FIREBASE_SECRET)) {
      console.log('Already processed this email_id, skipping (likely a webhook retry):', email_id);
      return new Response('ok');
    }
    await markProcessed(email_id, env.FIREBASE_SECRET);

    // ── 2. Fetch full email body from Resend ───────────────────────────────
    let emailText = '';
    try {
      const emailResp = await fetch(
        `https://api.resend.com/emails/receiving/${email_id}`,
        { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } }
      );
      if (!emailResp.ok) throw new Error(`Resend API ${emailResp.status}`);
      const emailData = await emailResp.json();
      // Prefer plain text; fall back to HTML stripped of tags
      emailText = emailData.text
        || (emailData.html ? emailData.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    } catch (err) {
      console.error('Failed to fetch email body:', err.message);
      return new Response('ok'); // don't block Resend retries
    }

    // ── 3. Gemini extracts a task and/or an event ──────────────────────────
    let extraction;
    try {
      extraction = await geminiExtract(subject, emailText, from, env.GEMINI_API_KEY);
    } catch (err) {
      console.error('Gemini error:', err.message);
      return new Response('ok');
    }

    if (!extraction) {
      console.log('Gemini: no actionable task or event, skipping');
      return new Response('ok');
    }

    const { task, event } = extraction;

    // ── 4. Write task (if any) to /todos, event (if any) to /events ───────
    let taskOk = true, eventOk = true;
    if (task) {
      try {
        const r = await firebasePost('todos', task, env.FIREBASE_SECRET);
        console.log('Task written to Firebase:', r.name, '→', task.text);
      } catch (err) {
        console.error('Firebase task write failed:', err.message);
        taskOk = false;
      }
    }
    if (event) {
      try {
        const r = await firebasePost('events', event, env.FIREBASE_SECRET);
        console.log('Event written to Firebase:', r.name, '→', event.title);
      } catch (err) {
        console.error('Firebase event write failed:', err.message);
        eventOk = false;
      }
    }
    if (!taskOk || !eventOk) {
      return new Response('Internal Error', { status: 500 }); // worth Resend retrying
    }

    return new Response('ok');
  },
};

// ── Idempotency tracking: /processedEmails/{email_id} ──────────────────────
async function alreadyProcessed(emailId, secret) {
  const resp = await fetch(`${FIREBASE_URL}/processedEmails/${emailId}.json?auth=${secret}`);
  if (!resp.ok) return false; // fail open — don't block processing on a transient read error
  const val = await resp.json();
  return val !== null;
}
async function markProcessed(emailId, secret) {
  try {
    await fetch(`${FIREBASE_URL}/processedEmails/${emailId}.json?auth=${secret}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Date.now()),
    });
  } catch (err) {
    console.error('Failed to mark email as processed (continuing anyway):', err.message);
  }
}

// ── Firebase RTDB write helper ─────────────────────────────────────────────
async function firebasePost(path, data, secret) {
  const resp = await fetch(`${FIREBASE_URL}/${path}.json?auth=${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Firebase ${resp.status}`);
  return resp.json();
}

// ── Gemini 1.5 Flash: extract a task and/or an event from the email ───────
async function geminiExtract(subject, body, from, apiKey) {
  const prompt = `You are an assistant for a Hong Kong University MAIB (Master in AI in Business) student that reads forwarded emails and extracts TWO independent things if present:

1. A TASK — something the student must personally do (register, submit, RSVP, pay, complete a form), optionally with a deadline.
2. An EVENT — something happening on a specific date or date range worth seeing on a calendar (info session, workshop, orientation, career fair, deadline day), whether or not it also implies a task.

An email can contain a task only, an event only, both, or neither. Do not invent either if it is not clearly present in the email. If the email is a newsletter, marketing email, or notification with no task and no dated event, return exactly: null

Email from: ${from}
Subject: ${subject}
Body:
${body.slice(0, 4000)}

Return ONLY valid JSON (no markdown, no explanation) matching exactly this schema, or the literal word null if there is neither a task nor an event:
{
  "task": {
    "text": "<concise task title, max 80 characters>",
    "description": "<optional longer explanation of what the task involves; if the email mentions a registration page, form, portal or any other relevant link, include the full URL(s) verbatim in this field so the student can click through — otherwise null>",
    "due": "<YYYY-MM-DD if a deadline is mentioned, otherwise null>",
    "priority": "<high if urgent/due soon, medium if important, low otherwise>",
    "course": "<must be EXACTLY one of these codes: ${COURSE_CODES.join(', ')} — only if the email is clearly about that specific course, otherwise null. Do not use a general programme name like 'MAIB' — that is not a valid code.>",
    "done": false,
    "createdAt": ${Date.now()},
    "source": "email"
  } | null,
  "event": {
    "title": "<concise event name, max 80 characters>",
    "description": "<optional longer explanation; include relevant URLs verbatim, otherwise null>",
    "start": "<YYYY-MM-DD, first/only day of the event>",
    "end": "<YYYY-MM-DD, last day of the event — same as start if single-day>",
    "allDay": "<true if no specific time is mentioned, false if a specific start/end time is given>",
    "startTime": "<HH:MM 24-hour, or null if allDay>",
    "endTime": "<HH:MM 24-hour, or null if allDay>",
    "venue": "<location/room, or null>",
    "course": "<must be EXACTLY one of these codes: ${COURSE_CODES.join(', ')} — only if clearly tied to that specific course, otherwise null. Do not use a general programme name like 'MAIB' — that is not a valid code.>",
    "type": "<short free-text category like Career, Orientation, Workshop, Social, Info Session, or null>",
    "source": "email",
    "createdAt": ${Date.now()}
  } | null
}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!resp.ok) throw new Error(`Gemini API ${resp.status}`);

  const data = await resp.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (!raw || raw === 'null') return null;

  // Strip markdown code fences if Gemini wraps the response (same fix as process_pdf.py)
  let cleaned = raw;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  if (cleaned === 'null') return null;

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Gemini returned invalid JSON:', cleaned);
    return null;
  }

  // Defensive: guard against Gemini emitting a string "null" for one half
  // instead of a bare null.
  const task = (parsed && typeof parsed.task === 'object' && parsed.task) || null;
  const event = (parsed && typeof parsed.event === 'object' && parsed.event) || null;
  if (!task && !event) return null;
  return { task, event };
}

// ── Verify Resend webhook signature (svix HMAC-SHA256) ────────────────────
async function verifySignature(headers, body, secret) {
  const svixId = headers.get('svix-id');
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature || !secret) {
    console.warn('Missing svix headers or webhook secret');
    return false;
  }

  // Reject timestamps older than 5 minutes (replay attack prevention)
  const ts = parseInt(svixTimestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    console.warn('Webhook timestamp too old');
    return false;
  }

  const toSign = `${svixId}.${svixTimestamp}.${body}`;

  // Svix signing secrets are "whsec_<base64>" — the key is the decoded bytes,
  // not the raw secret string.
  const secretBytes = Uint8Array.from(atob(secret.split('_')[1] || secret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBytes = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(toSign)
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  const expected = `v1,${computed}`;

  // svix-signature header may contain multiple space-separated signatures
  return svixSignature.split(' ').includes(expected);
}
