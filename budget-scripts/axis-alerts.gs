/**
 * Axis Bank alerts -> budget.html review queue
 *
 * Runs inside your own Google account. Every 15 minutes it reads new emails from
 * alerts@axis.bank.in (read-only) and adds each payment to budget/pending in the
 * adip-hku Firebase database. Nothing becomes an expense until you add it from the
 * review pop-up in budget.html. Only the parsed amount, date, payee and a short
 * excerpt are saved; the emails themselves never leave Google.
 *
 * Only emails that arrive after you run `setup` are read: earlier spending is
 * already in budget.html.
 *
 * Setup: in Project Settings -> Script Properties add FIREBASE_SECRET (the same
 * database secret hku-email-worker uses), then choose `setup` and press Run.
 */
const SETTINGS = {
  databaseURL: 'https://adip-hku-default-rtdb.asia-southeast1.firebasedatabase.app',
  sender: 'alerts@axis.bank.in',
  timeZone: 'Asia/Hong_Kong',  // the budget's days are Hong Kong days
  pauseMs: 400,               // gap between emails, to stay under Gmail's per-minute limit
  maxRunMs: 4.5 * 60 * 1000,  // stop well before Apps Script's 6-minute cap; the next run carries on
};

/** Run once: starts reading from now, and schedules the 15-minute check. */
function setup() {
  if (!secret()) throw new Error('Add FIREBASE_SECRET under Project Settings -> Script Properties first.');
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('lastInternalDate')) props.setProperty('lastInternalDate', String(Date.now()));
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncAxisAlerts')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('syncAxisAlerts').timeBased().everyMinutes(15).create();
  syncAxisAlerts();
}

/**
 * Reads alerts newer than the last run and queues the payments for review.
 * Works oldest first and saves progress every 50 emails, so a run that stops early
 * loses nothing and the next run picks up where it left off.
 */
function syncAxisAlerts() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('lastInternalDate') || 0);
  if (!since) throw new Error('Run setup first.');
  const ids = listMessageIds(`from:${SETTINGS.sender} after:${Math.floor(since / 1000)}`).reverse();   // Gmail lists newest first
  const known = ids.length ? firebase('get', 'budget/pending', null, 'shallow=true') || {} : {};

  let records = {};
  let checkpoint = since;
  let queued = 0;
  let caughtUp = true;

  const flush = () => {
    const count = Object.keys(records).length;
    if (count) firebase('patch', 'budget/pending', records);   // the Gmail id is the key, so nothing is queued twice
    queued += count;
    records = {};
    if (checkpoint > since) props.setProperty('lastInternalDate', String(checkpoint));
  };

  for (let i = 0; i < ids.length; i += 1) {
    if (known[ids[i]]) continue;   // already queued, added or deleted: never bring it back
    if (Date.now() - started > SETTINGS.maxRunMs) { caughtUp = false; break; }
    const message = getMessage(ids[i]);
    if (!message) { caughtUp = false; break; }   // still rate limited: stop and let the next run continue
    const internalDate = Number(message.internalDate);
    if (internalDate <= since) continue;   // Gmail's after: works in whole seconds
    checkpoint = Math.max(checkpoint, internalDate);
    const record = parseAlert(message);
    if (record) records[ids[i]] = record;
    if ((i + 1) % 50 === 0) flush();
    Utilities.sleep(SETTINGS.pauseMs);
  }
  flush();

  firebase('patch', 'budget/meta/axisSync', { lastSync: Date.now(), lastFound: queued, caughtUp });
  console.log(`Queued ${queued} payment(s) for review${caughtUp ? '.' : '; more to bring in on the next run.'}`);
}

/** Fetches one email, waiting and retrying if Gmail's per-minute limit is hit. Returns null if it still is. */
function getMessage(id) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return Gmail.Users.Messages.get('me', id, { format: 'full' });
    } catch (err) {
      if (!/quota|rate ?limit|too many/i.test(String(err))) throw err;
      console.warn(`Gmail rate limit reached; waiting before retry ${attempt}.`);
      Utilities.sleep(20000 * attempt);
    }
  }
  return null;
}

/**
 * Diagnostics: logs what the parser makes of the 5 most recent alerts, without saving anything.
 * Looks at past emails only to test the parser; the sync itself never reads them.
 */
function previewAlerts() {
  const ids = listMessageIds(`from:${SETTINGS.sender} newer_than:30d`).slice(0, 5);
  console.log(`Found ${ids.length} recent alert(s).`);
  ids.forEach((id) => {
    const message = Gmail.Users.Messages.get('me', id, { format: 'full' });
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    console.log(`SUBJECT: ${header(message, 'Subject')}\nTEXT: ${text.slice(0, 600)}\nPARSED: ${JSON.stringify(parseAlert(message))}`);
    Utilities.sleep(SETTINGS.pauseMs);
  });
}

function listMessageIds(query) {
  const ids = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', { q: query, maxResults: 100, pageToken });
    (page.messages || []).forEach((m) => ids.push(m.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/* ------------------------------------------------------------------ parsing */

/** Turns an alert into a payment to review, or null for anything that isn't money going out. */
function parseAlert(message) {
  const subject = header(message, 'Subject');
  const text = messageText(message);
  const all = `${subject}\n${text}`;
  // skip OTP emails themselves, but not alerts whose footer says "never share your OTP"
  if (/\bOTP\b|one[- ]time password/i.test(subject) || /\b\d{4,8}\s+is\s+(?:your\s+)?(?:OTP|one[- ]time)|\bOTP\s*(?:is|:)\s*\d{4,8}/i.test(text)) return null;

  const inr = money(all.match(/(?:Amount\s+(?:Debited|Credited|Spent)\s*[:\-]?\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i));
  if (inr == null) return null;   // not a transaction alert (statements, offers, ...)

  const type = detectType(all);
  if (type === 'credit') return null;   // the budget only tracks spending

  const when = new Date(Number(message.internalDate));
  const record = {
    inr,
    payee: describe(text) || null,
    channel: detectChannel(all),
    date: Utilities.formatDate(when, SETTINGS.timeZone, 'yyyy-MM-dd'),
    time: Utilities.formatDate(when, SETTINGS.timeZone, 'HH:mm'),
    subject: subject.slice(0, 160),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 400),
    unsure: !type,   // couldn't tell it was a payment; shown as such in the review
    status: 'new',
    createdAt: when.getTime(),
  };
  Object.keys(record).forEach((key) => record[key] == null && delete record[key]);
  return record;
}

function money(match) {
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function detectType(all) {
  if (/Amount\s+Debited/i.test(all)) return 'debit';
  if (/Amount\s+Credited/i.test(all)) return 'credit';
  const plain = all.replace(/credit\s+card/gi, 'card').replace(/debit\s+card/gi, 'card');
  const debit = plain.search(/\b(debited|spent|withdrawn|paid|purchase|debit)\b/i);
  const credit = plain.search(/\b(credited|received|refund(?:ed)?|reversal|reversed|credit)\b/i);
  if (debit < 0 && credit < 0) return null;
  if (debit < 0) return 'credit';
  if (credit < 0) return 'debit';
  return debit < credit ? 'debit' : 'credit';
}

function detectChannel(all) {
  // the transaction details win: alert footers often mention cards the payment didn't use
  if (/Transaction\s+Info\s*:\s*UPI|\bUPI\//i.test(all)) return 'UPI';
  const transferInfo = all.match(/\b(NEFT|IMPS|RTGS)\//);
  if (transferInfo) return transferInfo[1];
  if (/debited\s+from\s+your\s+A\/c[\s\S]*?\bat\s+(?:ECOM\s+)?(?:PUR|POS|ECOM)\//i.test(all)) return 'Debit card';
  if (/credit\s+card/i.test(all)) return 'Credit card';
  if (/debit\s+card/i.test(all)) return 'Debit card';
  if (/\bUPI\b/.test(all)) return 'UPI';
  if (/\bATM\b/.test(all)) return 'ATM';
  const transfer = all.match(/\b(NEFT|IMPS|RTGS)\b/);
  return transfer ? transfer[1] : 'Account';
}

const CODES = /^(UPI|P2M|P2A|IMPS|NEFT|RTGS|ATM|ATM-WDL|POS|PUR|ECOM|MB|IB|BIL|ONL|INB|TPT|ACH|NACH|\d+)$/i;

function describe(text) {
  const info = text.match(/(?:Transaction\s+Info|Info)\s*[:\-]\s*([^\n]+)/i);
  if (info) {
    const value = info[1].split(/\s{2,}|Not you|If this|Feel free|Avl\.?\s*Bal|Available/i)[0].trim();
    if (value.includes('/')) {
      const segments = value.split('/').map((s) => s.trim()).filter((s) => /[A-Za-z]{3,}/.test(s) && !CODES.test(s));
      // prefer a name over a reference number like AXISN123456
      const name = segments.find((s) => !/\d/.test(s)) || segments[0];
      if (name) return tidy(name);
    }
    return tidy(value);
  }
  // card alerts: "debited from your A/c ... on 12-11-2026 19:53:48 at PUR/KPayHKG*Thai Khaow Hom/0000265651/227898. Available ..."
  const card = text.match(/\bat\s+(?:ECOM\s+)?(?:PUR|POS|ECOM)\/([^\n]+?)(?:\.\s|\.?\s*Avail|\.?\s*Avl|\.?$)/im);
  if (card) {
    const segments = card[1].split('/').map((s) => s.trim()).filter((s) => /[A-Za-z]{3,}/.test(s) && !CODES.test(s));
    const name = segments.find((s) => !/\d/.test(s)) || segments[0];
    // drop the payment processor in front of the shop: KPayHKG*, BBMSL * , QFPay*, ...
    if (name) return tidy(name.replace(/^(?:KPay(?:HKG)?|BBMSL|QFPay|EFTPAY|SPECTRA|MPOS)\s*\*\s*/i, ''));
  }
  // "debited ... by NEFT/HDFC0123/ELEC": the name is the last plain-word part
  const transfer = text.match(/\bby\s+((?:NEFT|IMPS|RTGS)\/\S+)/i);
  if (transfer) {
    const parts = transfer[1].split('/').map((s) => s.replace(/[^A-Za-z0-9 &]/g, '')).filter((s) => /[A-Za-z]{3,}/.test(s) && !/\d/.test(s) && !CODES.test(s));
    if (parts.length) return tidy(parts[parts.length - 1]);
  }
  const merchant = text.match(/Merchant(?:\s+Name)?\s*[:\-]\s*([^\n]+)/i);
  if (merchant) return tidy(merchant[1]);
  const at = text.match(/\bat\s+(.+?)\s+on\s+\d{1,2}[-\/ ]/i);
  if (at) return tidy(at[1]);
  const to = text.match(/\b(?:to|towards|from)\s+([A-Za-z][A-Za-z0-9 &.'-]{2,40}?)(?:\s+on\b|\s+via\b|[.,\n])/);
  return to ? tidy(to[1]) : '';
}

function tidy(value) {
  return value.replace(/\s+/g, ' ').replace(/[.,;:\-\s]+$/, '').trim().slice(0, 60);
}

/* ------------------------------------------------------------------ helpers */

function header(message, name) {
  const found = (message.payload.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function messageText(message) {
  const parts = [];
  (function walk(part) {
    if (!part) return;
    if (part.parts) part.parts.forEach(walk);
    else if (part.body && part.body.data && /^text\/(plain|html)/i.test(part.mimeType || '')) {
      parts.push({ type: part.mimeType.toLowerCase(), text: decode(part.body.data) });
    }
  })(message.payload);
  const plain = parts.find((p) => p.type.startsWith('text/plain'));
  const html = parts.find((p) => p.type.startsWith('text/html'));
  const text = plain ? plain.text
    : html ? html.text
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<\/td>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      : (message.snippet || '');
  return text
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8377;|&#x20b9;|&#X20B9;/g, '₹')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

function decode(data) {
  const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function secret() {
  return PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET');
}

function firebase(method, path, body, query) {
  const url = `${SETTINGS.databaseURL}/${path}.json?auth=${encodeURIComponent(secret())}${query ? `&${query}` : ''}`;
  const options = { method, muteHttpExceptions: true };
  if (body != null) Object.assign(options, { contentType: 'application/json', payload: JSON.stringify(body) });
  const res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() >= 300) {
    throw new Error(`Firebase said ${res.getResponseCode()}: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText() || 'null');
}
