/**
 * VOIDMAIL — Proxy Backend
 *
 * RECEIVE:  GuerillaMail public API (no key needed)
 * SEND:     Mailjet REST API (free tier — 200 emails/day, no credit card)
 *
 * HOW TO GET A FREE MAILJET KEY:
 *  1. Sign up at https://app.mailjet.com/signup (free, no card)
 *  2. Go to Account → API Keys
 *  3. Copy your API Key and Secret Key
 *  4. Set these env vars in Vercel:
 *       MAILJET_API_KEY    = your_api_key
 *       MAILJET_SECRET_KEY = your_secret_key
 *       MAILJET_SENDER     = yourverified@yourdomain.com
 *
 * NOTE: Mailjet requires a verified sender email/domain (free).
 * The visible "From" will be your verified sender, but Reply-To is set
 * to the user's disposable Guerrilla address so replies come back to them.
 */

const GM = 'https://api.guerrillamail.com/ajax.php';

// sid → { phpsessid, email, seq, ts }
const sessions = new Map();

// ─── helpers ──────────────────────────────────────────────────

function gmUrl(params) {
  const u = new URL(GM);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

async function gmGet(url, phpsessid) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; VoidMail/1.0)',
    Accept: 'application/json',
  };
  if (phpsessid) headers['Cookie'] = `PHPSESSID=${phpsessid}`;

  const res  = await fetch(url, { headers });
  const text = await res.text();

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

      const ourSid = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(ourSid, {
        phpsessid: newId,
        email:     data.email_addr,
        seq:       0,
        ts:        Number(data.email_timestamp) || 0,
      });

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
        .filter(m => m.mail_id && m.mail_id !== '0')
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

      if (messages.length) {
        const max = Math.max(...messages.map(m => Number(m.id)));
        if (max > sess.seq) { sess.seq = max; sessions.set(sid, sess); }
      }

      return res.json({ messages, count: data.count || 0 });
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
        body:    data.mail_body        || '',
        date:    data.mail_date        || '',
        ts:      Number(data.mail_timestamp) || 0,
      });
    } catch (err) {
      return res.json({ error: 'read_failed', detail: err.message });
    }
  }

  // ── SEND EMAIL via Mailjet ─────────────────────────────────
  if (action === 'send') {
    if (!sid) return res.json({ error: 'missing_sid' });

    const sess = sessions.get(sid);
    if (!sess) return res.json({ error: 'session_expired' });

    const { to, subject, body } = req.query;
    if (!to || !subject || !body)
      return res.json({ error: 'missing_params' });

    const MJ_KEY    = process.env.MAILJET_API_KEY;
    const MJ_SECRET = process.env.MAILJET_SECRET_KEY;
    const MJ_FROM   = process.env.MAILJET_SENDER;

    // Not configured yet — return a helpful error
    if (!MJ_KEY || !MJ_SECRET || !MJ_FROM) {
      return res.json({
        error: 'send_not_configured',
        hint:  'Set MAILJET_API_KEY, MAILJET_SECRET_KEY, MAILJET_SENDER in Vercel env vars. Free signup: mailjet.com',
      });
    }

    try {
      const safeBody = body
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const payload = {
        Messages: [{
          From:    { Email: MJ_FROM,    Name: 'VoidMail' },
          ReplyTo: { Email: sess.email, Name: 'VoidMail Anonymous' },
          To:      [{ Email: to }],
          Subject: subject,
          TextPart: body,
          HTMLPart: `<pre style="font-family:monospace;white-space:pre-wrap;line-height:1.6">${safeBody}</pre><hr/><small style="color:#999">Sent anonymously via VoidMail &mdash; replies go to: ${sess.email}</small>`,
        }],
      };

      const mjRes = await fetch('https://api.mailjet.com/v3.1/send', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${MJ_KEY}:${MJ_SECRET}`).toString('base64'),
        },
        body: JSON.stringify(payload),
      });

      const mjData = await mjRes.json();

      if (mjRes.ok && mjData.Messages?.[0]?.Status === 'success') {
        return res.json({ ok: true });
      }

      const errMsg = mjData.Messages?.[0]?.Errors?.[0]?.ErrorMessage
                  || mjData.ErrorMessage
                  || JSON.stringify(mjData);

      return res.json({ error: 'send_failed', detail: errMsg });

    } catch (err) {
      return res.json({ error: 'send_error', detail: err.message });
    }
  }

  return res.json({ error: 'unknown_action' });
};
