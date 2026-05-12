/**
 * MIRZAPUR MAIL — Proxy Backend
 * Provider: GuerillaMail Public API (api.guerrillamail.com)
 * Official docs: https://www.guerrillamail.com/GuerrillaMailAPI.html
 *
 * Why GuerillaMail:
 *  - Genuinely public API, no key, no auth, stable since 2006
 *  - Returns PHPSESSID cookie for session continuity
 *  - check_email, fetch_email, get_email_address all documented
 *
 * Session model:
 *  - Frontend gets a short "sid" token from us on /generate
 *  - We map sid → { phpsessid, email, seq } in memory
 *  - Every inbox/read call forwards the correct PHPSESSID cookie to GM
 *  - If Vercel cold-starts (session lost), frontend gets session_expired
 *    and auto-regenerates a new address
 */

const GM = 'https://api.guerrillamail.com/ajax.php';

// sid → { phpsessid, email, seq, ts }
const sessions = new Map();

// ─── 10-minute inbox cache ────────────────────────────────────
// Keeps messages alive through provider blips and empty responses.
// Cleared on Vercel cold start — acceptable for disposable mail.

const CACHE_TTL  = 10 * 60 * 1000; // 10 minutes
const inboxCache = new Map();       // sid → { messages: [...], updatedAt: ms }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inboxCache.entries()) {
    if (now - entry.updatedAt > CACHE_TTL) {
      inboxCache.delete(key);
      sessions.delete(key);
    }
  }
}, 60 * 1000);

// ─── helpers ──────────────────────────────────────────────────

function gmUrl(params) {
  const u = new URL(GM);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

async function gmGet(url, phpsessid) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; MirzapurMail/1.0)',
    Accept: 'application/json',
  };
  if (phpsessid) headers['Cookie'] = `PHPSESSID=${phpsessid}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  let res, text;
  try {
    res  = await fetch(url, { headers, signal: ctrl.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // Rotate PHPSESSID if GM sends a new one
  const sc    = res.headers.get('set-cookie') || '';
  const match = sc.match(/PHPSESSID=([^;]+)/);
  const newId = match ? match[1] : phpsessid;

  let data;
  try { data = JSON.parse(text); }
  catch { data = { _raw: text }; }

  return { data, newId };
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g,  "'");
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── main handler ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { action, sid, email_id } = req.query;

  // ── GENERATE ──────────────────────────────────────────────
  if (action === 'generate') {
    try {
      const url = gmUrl({
        f: 'get_email_address', lang: 'en',
        ip: '127.0.0.1', agent: 'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, null);
      if (!data.email_addr) {
        return res.json({ error: 'no_email', debug: data });
      }

      // Create our session token
      const ourSid = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(ourSid, {
        phpsessid: newId,
        email:     data.email_addr,
        seq:       0,
        ts:        Number(data.email_timestamp) || 0,
      });

      inboxCache.set(ourSid, { messages: [], updatedAt: Date.now() });

      return res.json({
        email: data.email_addr,
        sid:   ourSid,
        ts:    data.email_timestamp || 0,
      });
    } catch (err) {
      return res.json({ error: 'generate_failed', detail: err.message });
    }
  }

  // ── INBOX ─────────────────────────────────────────────────
  if (action === 'inbox') {
    if (!sid) return res.json({ error: 'missing_sid', messages: [] });

    const sess = sessions.get(sid);
    if (!sess)  return res.json({ error: 'session_expired', messages: [] });

    try {
      const url = gmUrl({
        f: 'check_email', seq: sess.seq,
        ip: '127.0.0.1', agent: 'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, sess.phpsessid);
      sess.phpsessid = newId;
      sessions.set(sid, sess);

      const list     = Array.isArray(data.list) ? data.list : [];
      const messages = list
        .filter(m => {
          if (!m.mail_id || m.mail_id === '0') return false;
          const from    = String(m.mail_from    || '').toLowerCase();
          const subject = String(m.mail_subject || '').toLowerCase();
          if (from.includes('guerrillamail') || subject.includes('guerrillamail')) return false;
          return true;
        })
        .map(m => ({
          id:        String(m.mail_id),
          from:      m.mail_from   || '',
          subject:   htmlDecode(m.mail_subject  || '(no subject)'),
          preview:   htmlDecode(m.mail_excerpt  || ''),
          timestamp: Number(m.mail_timestamp)   || 0,
          read:      m.mail_read === 1,
          date:      m.mail_date || '',
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      // Advance seq so next poll only fetches newer mail
      if (messages.length) {
        const max = Math.max(...messages.map(m => Number(m.id)));
        if (max > sess.seq) { sess.seq = max; sessions.set(sid, sess); }
      }

      // ── 10-min cache merge ──────────────────────────────────
      // Merge fresh messages with cached ones so the inbox survives
      // empty provider responses and brief polling gaps.
      const prior  = inboxCache.get(sid);
      const cached = (prior && Date.now() - prior.updatedAt < CACHE_TTL)
        ? prior.messages : [];
      const seen   = new Set(messages.map(m => m.id));
      const merged = [
        ...messages,
        ...cached.filter(m => !seen.has(m.id)),
      ].sort((a, b) => b.timestamp - a.timestamp);
      inboxCache.set(sid, { messages: merged, updatedAt: Date.now() });

      return res.json({ messages: merged, count: merged.length });
    } catch (err) {
      return res.json({ error: 'inbox_failed', detail: err.message, messages: [] });
    }
  }

  // ── READ FULL EMAIL ────────────────────────────────────────
  if (action === 'read') {
    if (!sid || !email_id) return res.json({ error: 'missing_params' });

    const sess = sessions.get(sid);
    if (!sess) return res.json({ error: 'session_expired' });

    try {
      const url = gmUrl({
        f: 'fetch_email', email_id,
        ip: '127.0.0.1', agent: 'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, sess.phpsessid);
      sess.phpsessid = newId;
      sessions.set(sid, sess);

      return res.json({
        id:      String(data.mail_id   || ''),
        from:    data.mail_from        || '',
        subject: htmlDecode(data.mail_subject || '(no subject)'),
        body:    data.mail_body        || '',   // HTML, already filtered by GM
        date:    data.mail_date        || '',
        ts:      Number(data.mail_timestamp) || 0,
      });
    } catch (err) {
      return res.json({ error: 'read_failed', detail: err.message });
    }
  }

  return res.json({ error: 'unknown_action' });
};
