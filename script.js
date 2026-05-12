/* =============================================
   MIRZAPUR MAIL — Frontend Script
   Provider: GuerillaMail via /api/proxy
   ============================================= */

'use strict';

const PROXY = '/api/proxy';
const OTP_REGEX = /\b\d{4,8}\b/g;

// ── STATE ─────────────────────────────────────
let currentEmail    = '';
let currentSid      = '';        // our session token from proxy
let refreshInterval = null;
let isFetching      = false;
let inboxUnlocked   = false;
let seenIds         = new Set(); // track already-shown mail ids

// ── THREE.JS BACKGROUND ──────────────────────

(function initThree() {
  const canvas   = document.getElementById('bg-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 25;

  const count = 1800;
  const pos   = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) pos[i] = (Math.random() - 0.5) * 70;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.06, color: 0x440000 }));
  scene.add(pts);

  const geo2 = new THREE.BufferGeometry();
  const pos2 = new Float32Array(600 * 3);
  for (let i = 0; i < 600 * 3; i++) pos2[i] = (Math.random() - 0.5) * 50;
  geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  const pts2 = new THREE.Points(geo2, new THREE.PointsMaterial({ size: 0.1, color: 0x880000 }));
  scene.add(pts2);

  (function animate() {
    requestAnimationFrame(animate);
    pts.rotation.y  += 0.0004;
    pts.rotation.x  += 0.0001;
    pts2.rotation.y -= 0.0006;
    renderer.render(scene, camera);
  })();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();

// ── VISITOR COUNTER ──────────────────────────

(function animateCounter() {
  const el     = document.getElementById('visitor-count');
  const target = 5404 + Math.floor(Math.random() * 300);
  let cur = 0;
  const step = Math.ceil(target / 60);
  const t = setInterval(() => {
    cur = Math.min(cur + step, target);
    el.textContent = String(cur).padStart(4, '0');
    if (cur >= target) clearInterval(t);
  }, 25);
})();

// ── VISIBILITY POLLING PAUSE ─────────────────
// Stop polling when tab is hidden, resume when visible

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopRefresh();
  } else if (inboxUnlocked && currentSid) {
    fetchInbox();
    refreshInterval = setInterval(fetchInbox, 8000);
  }
});

// ── TOAST ────────────────────────────────────

let toastTimer;
function showToast(msg, duration = 2400) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ── OTP ──────────────────────────────────────

function extractOTP(text) {
  if (!text) return null;
  const m = String(text).match(OTP_REGEX);
  if (!m) return null;
  // Prefer 6-digit, then any 4-8 digit number
  return m.find(x => x.length === 6)
      || m.find(x => x.length >= 4)
      || null;
}

function showOTPStrip(code) {
  document.getElementById('otp-code').textContent = code;
  document.getElementById('otp-strip').style.display = 'flex';
}

function copyOTP() {
  const code = document.getElementById('otp-code').textContent;
  copyText(code);
  showToast('✓ OTP COPIED');
}

// ── COPY ─────────────────────────────────────

function copyEmail() {
  if (!currentEmail) return;
  copyText(currentEmail);
  showToast('✓ IDENTITY CAPTURED');
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyFallback(text));
  } else {
    copyFallback(text);
  }
}

function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, { position: 'fixed', opacity: '0' });
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ── REFRESH CONTROL ──────────────────────────

function stopRefresh() {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// ── LOCALSTORAGE PERSISTENCE ─────────────────
// Survives page refresh (not Vercel cold start, which clears server sessions)

function saveSession() {
  try {
    localStorage.setItem('mm_email', currentEmail);
    localStorage.setItem('mm_sid',   currentSid);
  } catch {}
}

function loadSession() {
  try {
    const email = localStorage.getItem('mm_email');
    const sid   = localStorage.getItem('mm_sid');
    return (email && sid) ? { email, sid } : null;
  } catch { return null; }
}

function clearSession() {
  try {
    localStorage.removeItem('mm_email');
    localStorage.removeItem('mm_sid');
  } catch {}
}

// ── GENERATE EMAIL ───────────────────────────

async function generateEmail() {
  const input = document.getElementById('email-display');
  input.value = 'HACKING...';
  input.style.color = '#555';

  stopRefresh();
  inboxUnlocked = false;
  seenIds.clear();
  lockInbox();
  document.getElementById('otp-strip').style.display = 'none';

  try {
    const res  = await fetch(`${PROXY}?action=generate`, { cache: 'no-store' });
    const data = await res.json();

    if (data.error || !data.email || !data.sid) {
      throw new Error(data.error || 'No email/sid returned');
    }

    currentEmail = data.email;
    currentSid   = data.sid;
    saveSession();

    input.value      = currentEmail;
    input.style.color = '';
    showToast('✓ NEW IDENTITY CREATED');
     unlockInbox();
  } catch (err) {
    console.error('[generate]', err);
    input.value       = 'ERROR — RETRY';
    input.style.color = '#ff0000';
  }
}

// ── SHARINGAN UNLOCK ─────────────────────────

function unlockInbox() {
  if (!currentEmail || !currentSid) {
    showToast('✗ GENERATE AN IDENTITY FIRST');
    return;
  }

  // Kill any existing interval BEFORE the timeout fires
  stopRefresh();

  const overlay = document.getElementById('sharingan-overlay');
  overlay.style.display = 'flex';

  setTimeout(() => {
    overlay.style.display = 'none';
    inboxUnlocked = true;
    revealInbox();
    fetchInbox();                                       // immediate first fetch
    refreshInterval = setInterval(fetchInbox, 8000);    // then every 8s
  }, 1400);
}

// ── LOCK / REVEAL INBOX ───────────────────────

function lockInbox() {
  document.getElementById('lock-screen').classList.remove('hidden');
  document.getElementById('inbox-inner').classList.remove('visible');
  document.getElementById('inbox-loader').style.display = 'none';
  document.getElementById('btn-refresh').style.display  = 'none';
  document.getElementById('inbox-messages').innerHTML   =
    '<div class="inbox-empty">WAITING FOR DATA PACKETS...</div>';
}

function revealInbox() {
  document.getElementById('lock-screen').classList.add('hidden');
  document.getElementById('inbox-inner').classList.add('visible');
  document.getElementById('btn-refresh').style.display = 'inline-flex';
}

// ── FETCH INBOX ──────────────────────────────

async function fetchInbox() {
  if (isFetching || !currentSid || !inboxUnlocked) return;
  isFetching = true;

  const loader = document.getElementById('inbox-loader');
  const inner  = document.getElementById('inbox-inner');

  loader.style.display = 'flex';
  inner.style.opacity  = '0.5';

  try {
    const res  = await fetch(`${PROXY}?action=inbox&sid=${currentSid}`, { cache: 'no-store' });
    const data = await res.json();

    // Server-side session expired (Vercel cold start) — auto-regenerate
    if (data.error === 'session_expired') {
      clearSession();
      stopRefresh();
      inboxUnlocked = false;
      lockInbox();
      showToast('⚠ SESSION EXPIRED — REGENERATING...', 3000);
      await generateEmail();
      return;
    }

    if (data.error) {
      console.warn('[inbox error]', data);
      return;
    }

    renderMessages(data.messages || []);

  } catch (err) {
    console.error('[inbox fetch error]', err);
  } finally {
    isFetching          = false;
    loader.style.display = 'none';
    inner.style.opacity  = '1';
  }
}

// ── RENDER MESSAGES ──────────────────────────

function renderMessages(messages) {
  const container = document.getElementById('inbox-messages');
  document.getElementById('otp-strip').style.display = 'none';

  if (!messages.length) {
    if (container.querySelector('.inbox-empty')) return; // already showing empty
    container.innerHTML = '<div class="inbox-empty">NO PACKETS FOUND</div>';
    return;
  }

  // Clear empty state if present
  if (container.querySelector('.inbox-empty')) container.innerHTML = '';

  // Show OTP from latest message preview
  const latestOTP = extractOTP(messages[0].preview + ' ' + messages[0].subject);
  if (latestOTP) showOTPStrip(latestOTP);

  // Only insert messages we haven't rendered yet
  let anyNew = false;
  messages.forEach(msg => {
    if (seenIds.has(msg.id)) return;
    seenIds.add(msg.id);
    anyNew = true;

    const card = buildCard(msg);
    container.insertBefore(card, container.firstChild); // newest on top
  });

  if (anyNew) {
    // Subtle flash to signal new mail arrived
    container.style.transition = 'opacity 0.15s';
    container.style.opacity = '0.6';
    setTimeout(() => { container.style.opacity = '1'; }, 150);
  }
}

function buildCard(msg) {
  const otp  = extractOTP(msg.preview + ' ' + msg.subject);
  const time = formatTime(msg.timestamp);

  const card = document.createElement('div');
  card.className = `msg-card${otp ? ' has-otp' : ''}`;
  card.dataset.id = msg.id;

  card.innerHTML = `
    <div class="msg-meta">
      <span class="msg-from">FROM: ${esc(msg.from)}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-subject">${esc(msg.subject)}</div>
    <div class="msg-preview">${esc(msg.preview)}</div>
    ${otp ? `<div class="msg-otp-tag">⚡ OTP: ${esc(otp)}</div>` : ''}
  `;

  card.addEventListener('click', () => openMessage(msg));
  return card;
}

// ── OPEN MESSAGE MODAL ────────────────────────

async function openMessage(msg) {
  // Show modal immediately with what we have, then load full body
  const modal = document.getElementById('msg-modal');
  document.getElementById('modal-subject').textContent = msg.subject;
  document.getElementById('modal-from').textContent    = 'FROM: ' + msg.from;
  document.getElementById('modal-time').textContent    = 'TIME: '  + formatTime(msg.timestamp);
  document.getElementById('modal-body').innerHTML      = '<div class="modal-loading">DECRYPTING MESSAGE...</div>';

  const otpModal = document.getElementById('modal-otp-strip');
  otpModal.style.display = 'none';

  document.getElementById('msg-modal-overlay').style.display = 'flex';

  // Fetch full body
  try {
    const res  = await fetch(`${PROXY}?action=read&sid=${currentSid}&email_id=${msg.id}`, { cache: 'no-store' });
    const data = await res.json();

    if (data.error) {
      document.getElementById('modal-body').innerHTML = `<p style="color:#555">Failed to load: ${data.error}</p>`;
      return;
    }

    // GM body is HTML with JS/iframes already stripped
    document.getElementById('modal-body').innerHTML = sanitizeBody(data.body);

    // OTP detection on full body
    const bodyText = data.body.replace(/<[^>]+>/g, ' ');
    const otp = extractOTP(bodyText + ' ' + data.subject);
    if (otp) {
      document.getElementById('modal-otp-code').textContent = otp;
      otpModal.style.display = 'flex';
      document.getElementById('modal-otp-copy').onclick = () => {
        copyText(otp);
        showToast('✓ OTP COPIED');
      };
    }

  } catch (err) {
    document.getElementById('modal-body').innerHTML = `<p style="color:#555">Error: ${err.message}</p>`;
  }
}

function closeModal() {
  document.getElementById('msg-modal-overlay').style.display = 'none';
}

// ── SANITIZE GM HTML BODY ─────────────────────
// GM already strips JS/iframes, but we additionally block external images by default

function sanitizeBody(html) {
  // Replace img src with data-src to prevent auto-loading
  return html.replace(/<img([^>]*)\ssrc=/gi, '<img$1 data-src=');
}

// ── HELPERS ──────────────────────────────────

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d    = new Date(Number(ts) * 1000);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60)    return `${Math.floor(diff)}s ago`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString();
  } catch { return ''; }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── INIT ─────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  // Bind modal close
  document.getElementById('msg-modal-close').addEventListener('click', closeModal);
  document.getElementById('msg-modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('msg-modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Try restoring previous session from localStorage
  const saved = loadSession();
  if (saved) {
    currentEmail = saved.email;
    currentSid   = saved.sid;
    const input  = document.getElementById('email-display');
    input.value      = currentEmail;
    input.style.color = '';
    showToast('✓ IDENTITY RESTORED', 2000);
  } else {
    await generateEmail();
  }
});
