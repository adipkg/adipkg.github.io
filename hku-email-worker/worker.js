/**
 * hku-email-worker
 * ────────────────
 * Receives Resend `email.received` webhooks, fetches the full email body,
 * sends it to Gemini Flash for task extraction, and writes the result to
 * the Firebase Realtime Database /todos path.
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

    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // Only handle inbound emails
    if (event.type !== 'email.received') {
      return new Response('ok');
    }

    const { email_id, subject, from } = event.data;
    console.log(`Received email: ${subject} from ${from} (id: ${email_id})`);

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

    // ── 3. Gemini extracts a structured task ───────────────────────────────
    let task;
    try {
      task = await geminiExtract(subject, emailText, from, env.GEMINI_API_KEY);
    } catch (err) {
      console.error('Gemini error:', err.message);
      return new Response('ok');
    }

    if (!task) {
      console.log('Gemini: not a task email, skipping');
      return new Response('ok');
    }

    // ── 4. Write task to Firebase RTDB /todos ─────────────────────────────
    try {
      const fbResp = await fetch(
        `${FIREBASE_URL}/todos.json?auth=${env.FIREBASE_SECRET}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(task),
        }
      );
      if (!fbResp.ok) throw new Error(`Firebase ${fbResp.status}`);
      const fbResult = await fbResp.json();
      console.log('Task written to Firebase:', fbResult.name, '→', task.text);
    } catch (err) {
      console.error('Firebase write failed:', err.message);
      return new Response('Internal Error', { status: 500 });
    }

    return new Response('ok');
  },
};

// ── Gemini 1.5 Flash: extract a task from the email ───────────────────────
async function geminiExtract(subject, body, from, apiKey) {
  const prompt = `You are a task extractor for a Hong Kong University MAIB (Master in AI in Business) student.

Analyse this forwarded email and extract ONE actionable task if present.
If the email is a newsletter, marketing email, notification with no action required,
or contains no clear task, return exactly: null

Email from: ${from}
Subject: ${subject}
Body:
${body.slice(0, 4000)}

Return ONLY valid JSON matching this exact schema, or the word null (no markdown, no explanation):
{
  "text": "<concise task description, max 80 characters>",
  "due": "<YYYY-MM-DD if a deadline is mentioned, otherwise null>",
  "priority": "<high if urgent/due soon, medium if important, low otherwise>",
  "course": "<one of: ${COURSE_CODES.join(', ')} — if the email is clearly about that course, otherwise null>",
  "done": false,
  "createdAt": ${Date.now()},
  "source": "email"
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

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('Gemini returned invalid JSON:', cleaned);
    return null;
  }
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
