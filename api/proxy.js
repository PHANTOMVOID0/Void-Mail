/**
 * VOIDMAIL — Proxy Backend
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
 *
 * Inbox cache:
 *  - sid → { messages: [...], updatedAt: timestamp }
 *  - Merges + deduplicates every poll response against cached messages
 *  - If provider returns empty, cached messages are served instead
 *  - Entries expire after 10 minutes; a 60s cleanup interval purges them
 *  - In-memory only — Vercel cold starts clear it (acceptable for temp mail)
 */

const GM = 'https://api.guerrillamail.com/ajax.php';

// sid → { phpsessid, email, seq, ts }
const sessions = new Map();

// ─── inbox cache (10 min TTL) ─────────────────────────────────
// sid → { messages: [...], updatedAt: ms }
// Survives provider blips; cleared on Vercel cold start (acceptable).

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const inboxCache = new Map();

// Purge expired entries every 60 s to keep serverless memory lean
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inboxCache.entries()) {
    if (now - entry.updatedAt > CACHE_TTL) inboxCache.delete(key);
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

  const res  = await fetch(url, { headers });
  const text = await res.text();

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

      // Fresh identity — start with a clean cache slot
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

      const list       = Array.isArray(data.list) ? data.list : [];
      const freshMsgs  = list
        .filter(m =>
          m.mail_id &&
          m.mail_id !== '0' &&
          !String(m.mail_from || '').toLowerCase().includes('guerrillamail') &&
          !String(m.mail_subject || '').toLowerCase().includes('guerrillamail')
        )
        .map(m => ({
          id:        String(m.mail_id),
          from:      m.mail_from   || '',
          subject:   htmlDecode(m.mail_subject  || '(no subject)'),
          preview:   htmlDecode(m.mail_excerpt  || ''),
          timestamp: Number(m.mail_timestamp)   || 0,
          read:      m.mail_read === 1,
          date:      m.mail_date || '',
        }));

      // ── Merge with cache ────────────────────────────────────
      // Pull previous messages (if cache is still warm)
      const cached   = inboxCache.get(sid);
      const prevMsgs = (cached && Date.now() - cached.updatedAt < CACHE_TTL)
        ? cached.messages
        : [];

      // Deduplicate: fresh messages take priority; fill in any prior ones by ID
      const seen     = new Set(freshMsgs.map(m => m.id));
      const merged   = [
        ...freshMsgs,
        ...prevMsgs.filter(m => !seen.has(m.id)),
      ].sort((a, b) => b.timestamp - a.timestamp);

      // Persist merged result
      inboxCache.set(sid, { messages: merged, updatedAt: Date.now() });

      // Use merged set as the response; if provider returned nothing,
      // cached messages still fill the inbox (up to TTL expiry).
      const messages = merged;

      // Advance seq so next poll only fetches newer mail
      if (freshMsgs.length) {
        const max = Math.max(...freshMsgs.map(m => Number(m.id)));
        if (max > sess.seq) { sess.seq = max; sessions.set(sid, sess); }
      }

      return res.json({ messages, count: messages.length, cached: prevMsgs.length > 0 });
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
