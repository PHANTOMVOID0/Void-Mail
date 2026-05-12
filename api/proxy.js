/**
 * VOID MAIL — Proxy Backend
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
 * FIXES APPLIED:
 *  1. INBOX: Added missing `email_addr` param to check_email — without it
 *     GuerillaMail checks a random session, not yours → inbox always empty.
 *  2. INBOX/GENERATE: Track and pass `seq` so only new emails are returned
 *     on each poll (prevents missed or repeated messages).
 *  3. INBOX: Update `seq` from response after each poll.
 *  4. SESSION CLEANUP: Auto-delete sessions older than 1 hour to prevent
 *     unbounded memory growth on Vercel (previously leaked forever).
 *  5. GENERATE: Validate `email_addr` AND `sid_token` from GM response
 *     before trusting it.
 */

const GM = 'https://api.guerrillamail.com/ajax.php';

// sid → { phpsessid, email, seq, ts, createdAt }
const sessions = new Map();

// ─── session cleanup (prevent memory leak on long-running instances) ──────────

function pruneSessions() {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, sess] of sessions.entries()) {
    if (now - sess.createdAt > ONE_HOUR) {
      sessions.delete(key);
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function gmUrl(params) {
  const u = new URL(GM);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

async function gmGet(url, phpsessid) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; VoidMail/2.0)',
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

// ─── main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Prune stale sessions on every request (lightweight, O(n) but n is small)
  pruneSessions();

  const { action, sid, email_id } = req.query;

  // ── GENERATE ────────────────────────────────────────────────────────────────
  if (action === 'generate') {
    try {
      const url = gmUrl({
        f:     'get_email_address',
        lang:  'en',
        ip:    '127.0.0.1',
        agent: 'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, null);

      // FIX 5: validate both required fields before trusting the response
      if (!data.email_addr || !data.sid_token) {
        return res.json({ error: 'no_email', debug: data });
      }

      const ourSid = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

      sessions.set(ourSid, {
        phpsessid: newId,
        email:     data.email_addr,
        seq:       Number(data.seq) || 0,   // FIX 2: store initial seq
        ts:        Number(data.email_timestamp) || 0,
        createdAt: Date.now(),               // FIX 4: for cleanup
      });

      return res.json({
        email: data.email_addr,
        sid:   ourSid,
        ts:    data.email_timestamp || 0,
      });

    } catch (err) {
      return res.json({
        error:  'generate_failed',
        detail: err.message,
      });
    }
  }

  // ── INBOX ────────────────────────────────────────────────────────────────────
  if (action === 'inbox') {

    if (!sid) {
      return res.json({ error: 'missing_sid', messages: [] });
    }

    const sess = sessions.get(sid);
    if (!sess) {
      return res.json({ error: 'session_expired', messages: [] });
    }

    try {
      const url = gmUrl({
        f:          'check_email',
        seq:        sess.seq || 0,      // FIX 2: pass current seq
        email_addr: sess.email,         // FIX 1: tell GM which inbox to check
        ip:         '127.0.0.1',
        agent:      'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, sess.phpsessid);

      // FIX 3: update seq so next poll only fetches newer messages
      sess.seq       = Number(data.seq) || sess.seq;
      sess.phpsessid = newId;
      sessions.set(sid, sess);

      const list = Array.isArray(data.list) ? data.list : [];

      const messages = list
        .filter(m =>
          m.mail_id &&
          m.mail_id !== '0' &&
          !String(m.mail_from    || '').toLowerCase().includes('guerrillamail') &&
          !String(m.mail_subject || '').toLowerCase().includes('guerrillamail')
        )
        .map(m => ({
          id:        String(m.mail_id),
          from:      m.mail_from || '',
          subject:   htmlDecode(m.mail_subject || '(no subject)'),
          preview:   htmlDecode(m.mail_excerpt || ''),
          timestamp: Number(m.mail_timestamp) || 0,
          read:      m.mail_read === 1,
          date:      m.mail_date || '',
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      return res.json({
        messages,
        count: data.count || 0,
      });

    } catch (err) {
      return res.json({
        error:    'inbox_failed',
        detail:   err.message,
        messages: [],
      });
    }
  }

  // ── READ FULL EMAIL ──────────────────────────────────────────────────────────
  if (action === 'read') {
    if (!sid || !email_id) return res.json({ error: 'missing_params' });

    const sess = sessions.get(sid);
    if (!sess) return res.json({ error: 'session_expired' });

    try {
      const url = gmUrl({
        f:        'fetch_email',
        email_id,
        ip:       '127.0.0.1',
        agent:    'Mozilla_foo_bar',
      });

      const { data, newId } = await gmGet(url, sess.phpsessid);
      sess.phpsessid = newId;
      sessions.set(sid, sess);

      return res.json({
        id:      String(data.mail_id    || ''),
        from:    data.mail_from         || '',
        subject: htmlDecode(data.mail_subject || '(no subject)'),
        body:    data.mail_body         || '',  // HTML, already filtered by GM
        date:    data.mail_date         || '',
        ts:      Number(data.mail_timestamp) || 0,
      });
    } catch (err) {
      return res.json({ error: 'read_failed', detail: err.message });
    }
  }

  return res.json({ error: 'unknown_action' });
};
