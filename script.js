/* =============================================
   VOIDMAIL — Frontend Script
   Provider: GuerillaMail via /api/proxy
   ============================================= */

'use strict';

const PROXY = '/api/proxy';
const OTP_REGEX = /\b\d{4,8}\b/g;

// ── STATE ─────────────────────────────────────
let currentEmail    = '';
let currentSid      = '';
let refreshInterval = null;
let countdownTimer  = null;
let isFetching      = false;
let inboxUnlocked   = false;
let seenIds         = new Set();
let countdownVal    = 15;

// ── THREE.JS BACKGROUND ──────────────────────

(function initThree() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 25;

  // Layer 1 — dim background particles
  const count = 2000;
  const pos   = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) pos[i] = (Math.random() - 0.5) * 80;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, color: 0x330011 }));
  scene.add(pts);

  // Layer 2 — mid accent particles
  const pos2 = new Float32Array(700 * 3);
  for (let i = 0; i < 700 * 3; i++) pos2[i] = (Math.random() - 0.5) * 55;
  const geo2 = new THREE.BufferGeometry();
  geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  const pts2 = new THREE.Points(geo2, new THREE.PointsMaterial({ size: 0.09, color: 0x880022 }));
  scene.add(pts2);

  // Layer 3 — bright red sparks
  const pos3 = new Float32Array(150 * 3);
  for (let i = 0; i < 150 * 3; i++) pos3[i] = (Math.random() - 0.5) * 35;
  const geo3 = new THREE.BufferGeometry();
  geo3.setAttribute('position', new THREE.BufferAttribute(pos3, 3));
  const pts3 = new THREE.Points(geo3, new THREE.PointsMaterial({ size: 0.15, color: 0xff1744 }));
  scene.add(pts3);

  (function animate() {
    requestAnimationFrame(animate);
    pts.rotation.y  += 0.0003;
    pts.rotation.x  += 0.0001;
    pts2.rotation.y -= 0.0005;
    pts2.rotation.z += 0.0002;
    pts3.rotation.y += 0.001;
    pts3.rotation.x -= 0.0008;
    renderer.render(scene, camera);
  })();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();

// ── VISIBILITY POLLING PAUSE ─────────────────

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopRefresh();
  } else if (inboxUnlocked && currentSid) {
    fetchInbox();
    startRefreshCycle();
  }
});

// ── TOAST ────────────────────────────────────

let toastTimer;
function showToast(msg, duration = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
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
  return m.find(x => x.length === 6)
      || m.find(x => x.length >= 4)
      || null;
}

function showOTPBanner(code) {
  const banner = document.getElementById('otp-banner');
  const val    = document.getElementById('otp-value');
  if (!banner || !val) return;
  val.textContent = code;
  banner.style.display = 'flex';

  // Pulse animation re-trigger
  banner.classList.remove('otp-pulse');
  void banner.offsetWidth;
  banner.classList.add('otp-pulse');
}

function hideOTPBanner() {
  const banner = document.getElementById('otp-banner');
  if (banner) banner.style.display = 'none';
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

// ── STATUS BAR ───────────────────────────────

function setStatus(state, msgCount) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const msgs = document.getElementById('status-msgs');

  if (!dot || !text) return;

  dot.className = 'status-dot';

  if (state === 'online') {
    dot.classList.add('online');
    text.textContent = 'ONLINE';
  } else if (state === 'scanning') {
    dot.classList.add('scanning');
    text.textContent = 'SCANNING';
  } else {
    text.textContent = 'OFFLINE';
  }

  if (msgs && msgCount !== undefined) {
    msgs.textContent = `${msgCount} MSG${msgCount !== 1 ? 'S' : ''}`;
  }
}

// ── REFRESH CONTROL ──────────────────────────

function stopRefresh() {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  stopCountdown();
}

function startRefreshCycle() {
  stopRefresh();
  startCountdown();
  refreshInterval = setInterval(() => {
    fetchInbox();
    startCountdown(); // reset countdown after each poll
  }, 3000);
}

function startCountdown() {
  stopCountdown();
  countdownVal = 3;
  updateCountdown();
  countdownTimer = setInterval(() => {
    countdownVal = Math.max(0, countdownVal - 1);
    updateCountdown();
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function updateCountdown() {
  const el = document.getElementById('refresh-countdown');
  if (el) el.textContent = countdownVal;
}

// ── LOCALSTORAGE PERSISTENCE ─────────────────

function saveSession() {
  try {
    localStorage.setItem('vm_email', currentEmail);
    localStorage.setItem('vm_sid',   currentSid);
  } catch {}
}

function loadSession() {
  try {
    const email = localStorage.getItem('vm_email');
    const sid   = localStorage.getItem('vm_sid');
    return (email && sid) ? { email, sid } : null;
  } catch { return null; }
}

function clearSession() {
  try {
    localStorage.removeItem('vm_email');
    localStorage.removeItem('vm_sid');
  } catch {}
}

// ── EMAIL DISPLAY HELPERS ────────────────────

function setEmailDisplay(text, isPlaceholder = false) {
  const box = document.getElementById('email-display');
  if (!box) return;

  if (isPlaceholder) {
    box.innerHTML = '<span class="email-placeholder">_ _ _ _ _ _ _ _ @ _ _ _ _ . _ _ _</span>';
  } else {
    box.textContent = text;
  }
}

// ── GENERATE EMAIL ───────────────────────────

async function generateEmail() {
  setEmailDisplay('HACKING...', false);

  const copyBtn    = document.getElementById('btn-copy');
  const refreshBtn = document.getElementById('btn-refresh-manual');
  const indicator  = document.getElementById('refresh-indicator');

  if (copyBtn)    copyBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (indicator)  indicator.style.display = 'none';

  stopRefresh();
  inboxUnlocked = false;
  seenIds.clear();
  setStatus('offline');
  hideOTPBanner();
  resetInboxUI();

  try {
    const res  = await fetch(`${PROXY}?action=generate`, { cache: 'no-store' });
    const data = await res.json();

    if (data.error || !data.email || !data.sid) {
      throw new Error(data.error || 'No email/sid returned');
    }

    currentEmail = data.email;
    currentSid   = data.sid;
    saveSession();

    setEmailDisplay(currentEmail, false);
    if (copyBtn)    { copyBtn.disabled = false; }
    if (refreshBtn) { refreshBtn.disabled = false; }
    if (indicator)  { indicator.style.display = 'flex'; }

    showToast('✓ NEW IDENTITY CREATED');
    setStatus('online', 0);

    // Immediately unlock inbox and begin polling
    inboxUnlocked = true;
    await fetchInbox();
    startRefreshCycle();

  } catch (err) {
    console.error('[generate]', err);
    setEmailDisplay('ERROR — RETRY', false);
    showToast('✗ GENERATION FAILED');
    setStatus('offline');
  }
}

// ── RESET INBOX UI ────────────────────────────

function resetInboxUI() {
  const list = document.getElementById('inbox-list');
  if (!list) return;

  // Remove message cards but keep the empty placeholder
  Array.from(list.querySelectorAll('.inbox-card')).forEach(c => c.remove());

  let empty = document.getElementById('inbox-empty');
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.id = 'inbox-empty';
    empty.innerHTML = `
      <div class="empty-icon">▣</div>
      <div class="empty-title">NO TRANSMISSIONS DETECTED</div>
      <div class="empty-sub">Generate an identity above to begin intercepting messages</div>
    `;
    list.appendChild(empty);
  }
  empty.style.display = 'flex';
}

// ── FETCH INBOX ──────────────────────────────

async function fetchInbox() {
  if (isFetching || !currentSid || !inboxUnlocked) return;
  isFetching = true;

  const loading = document.getElementById('inbox-loading');
  setStatus('scanning');

  if (loading) loading.style.display = 'flex';

  try {
    const res  = await fetch(`${PROXY}?action=inbox&sid=${currentSid}`, { cache: 'no-store' });
    const data = await res.json();

    // Server-side session expired (Vercel cold start) — auto-regenerate
    if (data.error === 'session_expired') {
      clearSession();
      stopRefresh();
      inboxUnlocked = false;
      setStatus('offline');
      showToast('⚠ SESSION EXPIRED — REGENERATING...', 3000);
      await generateEmail();
      return;
    }

    if (data.error) {
      console.warn('[inbox error]', data);
      setStatus('online');
      return;
    }

    const messages = data.messages || [];
    setStatus('online', messages.length);
    renderMessages(messages);

  } catch (err) {
    console.error('[inbox fetch error]', err);
    setStatus('online');
  } finally {
    isFetching = false;
    if (loading) loading.style.display = 'none';
  }
}

// ── RENDER MESSAGES ──────────────────────────

function renderMessages(messages) {
  const list  = document.getElementById('inbox-list');
  const empty = document.getElementById('inbox-empty');

  hideOTPBanner();

  if (!messages.length) {
    if (empty) empty.style.display = 'flex';
    return;
  }

  // Hide empty state
  if (empty) empty.style.display = 'none';

  // Show OTP from latest message preview
  const latestOTP = extractOTP(messages[0].preview + ' ' + messages[0].subject);
  if (latestOTP) showOTPBanner(latestOTP);

  // Only insert messages we haven't rendered yet
  let anyNew = false;
  messages.forEach(msg => {
    if (seenIds.has(msg.id)) return;
    seenIds.add(msg.id);
    anyNew = true;

    const card = buildCard(msg);
    // Insert newest on top, before existing cards (not before empty placeholder)
    const firstCard = list.querySelector('.inbox-card');
    if (firstCard) {
      list.insertBefore(card, firstCard);
    } else {
      list.appendChild(card);
    }

    // Staggered entrance animation
    card.style.opacity = '0';
    card.style.transform = 'translateX(-12px)';
    requestAnimationFrame(() => {
      card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      card.style.opacity = '1';
      card.style.transform = 'translateX(0)';
    });
  });

  if (anyNew) showToast('⚡ NEW TRANSMISSION INTERCEPTED');
}

function buildCard(msg) {
  const otp  = extractOTP(msg.preview + ' ' + msg.subject);
  const time = formatTime(msg.timestamp);

  const card = document.createElement('div');
  card.className = `inbox-card${otp ? ' has-otp' : ''}`;
  card.dataset.id = msg.id;

  card.innerHTML = `
    <div class="card-top">
      <span class="card-from">FROM: ${esc(msg.from)}</span>
      <span class="card-time">${time}</span>
    </div>
    <div class="card-subject">${esc(msg.subject)}</div>
    <div class="card-preview">${esc(msg.preview)}</div>
    ${otp ? `<div class="card-otp-tag">⚡ OTP: ${esc(otp)}</div>` : ''}
  `;

  card.addEventListener('click', () => openMessage(msg));
  return card;
}

// ── OPEN MESSAGE MODAL ────────────────────────

async function openMessage(msg) {
  const overlay = document.getElementById('msg-modal-overlay');

  document.getElementById('modal-subject').textContent = msg.subject;
  document.getElementById('modal-from').textContent    = 'FROM: ' + msg.from;
  document.getElementById('modal-time').textContent    = 'TIME: ' + formatTime(msg.timestamp);
  document.getElementById('modal-body').innerHTML      = '<div class="modal-loading">DECRYPTING TRANSMISSION...</div>';

  const otpModalBanner = document.getElementById('otp-modal-banner');
  if (otpModalBanner) otpModalBanner.style.display = 'none';

  overlay.style.display = 'flex';

  try {
    const res  = await fetch(`${PROXY}?action=read&sid=${currentSid}&email_id=${msg.id}`, { cache: 'no-store' });
    const data = await res.json();

    if (data.error) {
      document.getElementById('modal-body').innerHTML =
        `<p style="color:var(--text-secondary)">Failed to load: ${data.error}</p>`;
      return;
    }

    document.getElementById('modal-body').innerHTML = sanitizeBody(data.body);

    // OTP detection on full body
    const bodyText = data.body.replace(/<[^>]+>/g, ' ');
    const otp = extractOTP(bodyText + ' ' + data.subject);
    if (otp && otpModalBanner) {
      const valEl = document.getElementById('otp-modal-val');
      if (valEl) valEl.textContent = otp;
      otpModalBanner.style.display = 'flex';

      const copyBtn = document.getElementById('btn-otp-copy-modal');
      if (copyBtn) {
        copyBtn.onclick = () => {
          copyText(otp);
          showToast('✓ OTP COPIED');
        };
      }
    }

  } catch (err) {
    document.getElementById('modal-body').innerHTML =
      `<p style="color:var(--text-secondary)">Error: ${err.message}</p>`;
  }
}

function closeModal() {
  const overlay = document.getElementById('msg-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ── SANITIZE GM HTML BODY ─────────────────────

function sanitizeBody(html) {
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

  // ── Button bindings ──
  const btnGenerate = document.getElementById('btn-generate');
  const btnCopy     = document.getElementById('btn-copy');
  const btnRefresh  = document.getElementById('btn-refresh-manual');
  const btnOtpCopy  = document.getElementById('btn-otp-copy');

  if (btnGenerate) btnGenerate.addEventListener('click', generateEmail);
  if (btnCopy)     btnCopy.addEventListener('click', copyEmail);
  if (btnRefresh)  btnRefresh.addEventListener('click', () => fetchInbox());
  if (btnOtpCopy)  {
    btnOtpCopy.addEventListener('click', () => {
      const code = document.getElementById('otp-value')?.textContent;
      if (code) { copyText(code); showToast('✓ OTP COPIED'); }
    });
  }

  // ── Modal bindings ──
  document.getElementById('msg-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('msg-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('msg-modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // ── Try restoring previous session ──
  const saved = loadSession();
  if (saved) {
    currentEmail  = saved.email;
    currentSid    = saved.sid;
    inboxUnlocked = true;

    setEmailDisplay(currentEmail, false);
    setStatus('online', 0);

    const copyBtn    = document.getElementById('btn-copy');
    const refreshBtn = document.getElementById('btn-refresh-manual');
    const indicator  = document.getElementById('refresh-indicator');

    if (copyBtn)    copyBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (indicator)  indicator.style.display = 'flex';

    showToast('✓ IDENTITY RESTORED', 2000);

    await fetchInbox();
    startRefreshCycle();
  } else {
    await generateEmail();
  }
});
