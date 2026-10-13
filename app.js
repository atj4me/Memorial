/* Starbound — private letters to the stars.
 * Vanilla JS, no dependencies, no network calls. All data in IndexedDB, local only. */
'use strict';

/* ---------------- styled dialogs (SweetAlert2, self-hosted: stays on-device) ---------------- */
const SwalLib = window.Sweetalert2 || window.Swal;
function appAlert(message) {
  if (!SwalLib) { alert(message); return Promise.resolve(); }
  return SwalLib.fire({
    text: message,
    confirmButtonText: 'OK',
    background: '#141a33',
    color: '#f5efe2',
    backdrop: 'rgba(4, 6, 16, 0.72)',
    confirmButtonColor: '#7c5cff',
    customClass: { popup: 'sb-swal' },
  });
}
function appConfirm(message, opts = {}) {
  if (!SwalLib) return Promise.resolve(confirm(message));
  return SwalLib.fire({
    text: message,
    showCancelButton: true,
    confirmButtonText: opts.confirmText || 'Yes',
    cancelButtonText: 'Cancel',
    reverseButtons: true,
    focusCancel: true,
    background: '#141a33',
    color: '#f5efe2',
    backdrop: 'rgba(4, 6, 16, 0.72)',
    confirmButtonColor: opts.danger ? '#e5484d' : '#7c5cff',
    customClass: { popup: 'sb-swal' },
  }).then((r) => !!r.isConfirmed);
}

/* ---------------- utils ---------------- */
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/* Downscale photos so IndexedDB stays reasonable. Videos are kept as-is. */
function downscaleImage(dataURL, maxDim = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataURL);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'memorial';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('spaces')) db.createObjectStore('spaces', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('messages')) {
        const ms = db.createObjectStore('messages', { keyPath: 'id' });
        ms.createIndex('by-space', 'spaceId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const out = fn(os);
    t.oncomplete = () => resolve(out && typeof out.then === 'function' ? out : undefined);
    t.onerror = () => reject(t.error);
  }));
}
const reqAsPromise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const store = {
  spaces: {
    all: () => tx('spaces', 'readonly', (os) => reqAsPromise(os.getAll())),
    get: (id) => tx('spaces', 'readonly', (os) => reqAsPromise(os.get(id))),
    put: (s) => tx('spaces', 'readwrite', (os) => reqAsPromise(os.put(s))),
    del: (id) => tx('spaces', 'readwrite', (os) => reqAsPromise(os.delete(id))),
  },
  messages: {
    bySpace: (spaceId) => tx('messages', 'readonly', (os) => reqAsPromise(os.index('by-space').getAll(spaceId))),
    all: () => tx('messages', 'readonly', (os) => reqAsPromise(os.getAll())),
    put: (m) => tx('messages', 'readwrite', (os) => reqAsPromise(os.put(m))),
    del: (id) => tx('messages', 'readwrite', (os) => reqAsPromise(os.delete(id))),
    clear: () => tx('messages', 'readwrite', (os) => reqAsPromise(os.clear())),
  },
};

/* ---------------- state & navigation ---------------- */
let currentSpaceId = null;
let pendingAttachments = []; // {kind:'photo'|'video'|'voice', dataUrl, mime}
let sky = null; // starfield API from initStarfield()

/* ---------------- your stars ----------------
 * Each space is a star pinned to a fixed point in your sky (starX/starY
 * are fractions of the viewport; hue is an "r, g, b" triplet string).
 * Messages released inside a space fly to that star and make it flare. */
const STAR_HUES = ['190, 220, 255', '255, 220, 180', '255, 180, 220', '190, 255, 220', '225, 195, 255'];
const pickHue = () => STAR_HUES[(Math.random() * STAR_HUES.length) | 0];

function pickStarPosition(existing) {
  let best = null, bestD = -1;
  for (let i = 0; i < 24; i++) {
    const c = { starX: 0.1 + Math.random() * 0.8, starY: 0.1 + Math.random() * 0.62 };
    let d = Infinity;
    for (const s of existing) {
      if (typeof s.starX !== 'number' || typeof s.starY !== 'number') continue;
      d = Math.min(d, Math.hypot(s.starX - c.starX, s.starY - c.starY));
    }
    if (d > bestD) { bestD = d; best = c; }
  }
  return best || { starX: 0.5, starY: 0.3 };
}

async function ensureStarPositions() {
  const spaces = await store.spaces.all();
  for (const s of spaces) {
    let changed = false;
    if (typeof s.starX !== 'number' || typeof s.starY !== 'number') {
      Object.assign(s, pickStarPosition(spaces));
      changed = true;
    }
    if (typeof s.hue !== 'string') { s.hue = pickHue(); changed = true; }
    if (changed) await store.spaces.put(s);
  }
}

async function syncSky() {
  if (!sky) return;
  const spaces = await store.spaces.all();
  sky.setUserStars(spaces, currentSpaceId);
}

function showView(name) {
  $('view-spaces').hidden = name !== 'spaces';
  $('view-space').hidden = name !== 'space';
  document.body.classList.add('in-space'); // the whole app is dark themed
  window.scrollTo(0, 0);
}

/* ---------------- ambient starfield (living night sky) ---------------- */
function initStarfield() {
  const c = document.createElement('canvas');
  c.id = 'starfield';
  c.setAttribute('aria-hidden', 'true');
  document.body.prepend(c);
  const ctx = c.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, stars = [];
  let userStars = []; // [{id, x, y, hue, tw}] — the user's own pinned stars
  let activeStarId = null;
  const boosts = {}; // id -> timestamp until which the star shines extra bright

  // Deterministic sky: the same background stars on every load, so a refresh
  // never reshuffles the heavens. (Your own stars are pinned separately.)
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const seed = () => {
    const rnd = mulberry32(20261013);
    stars = [];
    const n = Math.round(Math.min(220, Math.max(120, (W * H) / 12000)));
    for (let i = 0; i < n; i++) {
      const hero = rnd() < 0.1;
      const blinker = !hero && rnd() < 0.22; // stars that visibly blink
      const tint = rnd();
      stars.push({
        x: rnd(), // fractional: stable across resizes (URL bar show/hide)
        y: rnd(),
        r: hero ? 1.6 + rnd() * 1.2 : blinker ? 1 + rnd() * 1.2 : 0.6 + rnd() * 1.1,
        base: blinker ? 0.5 : 0.25 + rnd() * 0.5,
        amp: blinker ? 0.5 : 0.2 + rnd() * 0.45,
        ph: rnd() * Math.PI * 2,
        sp: blinker ? 1.5 + rnd() * 2.5 : 0.6 + rnd() * 2.2,
        hero,
        blinker,
        hue: tint < 0.15 ? '190, 220, 255' : tint < 0.27 ? '255, 220, 180' : '255, 255, 255',
      });
    }
  };
  const fit = () => {
    W = window.innerWidth; H = window.innerHeight;
    c.width = Math.max(1, Math.round(W * DPR));
    c.height = Math.max(1, Math.round(H * DPR));
  };
  fit();
  seed(); // once: fractional coords keep stars stable when the viewport resizes
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(fit, 250); });

  let meteor = null;
  let nextMeteor = performance.now() + 7000 + Math.random() * 8000;

  function drawStars(el) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      const tw = s.base + s.amp * (0.5 + 0.5 * Math.sin(s.ph + el * s.sp));
      const a = Math.max(0.05, Math.min(1, tw)).toFixed(3);
      const px = s.x * W, py = s.y * H;
      if (s.hero) {
        ctx.save();
        ctx.shadowColor = `rgba(${s.hue}, 0.85)`;
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${s.hue}, ${a})`;
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${s.hue}, ${a})`;
        ctx.fill();
      }
    }

    // ---- the user's own stars: pinned, bright, gently pulsing ----
    const nowMs = performance.now();
    for (const u of userStars) {
      const px = u.x * W, py = u.y * H;
      const isActive = u.id === activeStarId;
      const boost = Math.max(0, Math.min(1, ((boosts[u.id] || 0) - nowMs) / 9000)); // extra brilliance fading over 9s
      const pulse = 0.82 + 0.18 * Math.sin(el * 1.7 + u.tw);
      const R = Math.max(1.2, (isActive ? 3.2 : 2.5) * (1 + boost * 0.7) * pulse);
      const haloR = R * (isActive ? 10 : 8);
      const hg = ctx.createRadialGradient(px, py, 0, px, py, haloR);
      hg.addColorStop(0, `rgba(${u.hue}, ${(0.42 * pulse + boost * 0.35).toFixed(3)})`);
      hg.addColorStop(1, `rgba(${u.hue}, 0)`);
      ctx.beginPath();
      ctx.arc(px, py, haloR, 0, Math.PI * 2);
      ctx.fillStyle = hg;
      ctx.fill();
      ctx.save();
      ctx.shadowColor = `rgba(${u.hue}, 0.95)`;
      ctx.shadowBlur = 12 + boost * 16;
      ctx.beginPath();
      ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 0.92 * pulse + boost * 0.4).toFixed(3)})`;
      ctx.fill();
      ctx.restore();
    }
  }

  const api = {
    setUserStars(list, activeId) {
      userStars = (list || [])
        .filter((s) => typeof s.starX === 'number' && typeof s.starY === 'number')
        .map((s) => ({ id: s.id, x: s.starX, y: s.starY, hue: s.hue || '255, 220, 180', tw: Math.random() * Math.PI * 2 }));
      activeStarId = activeId || null;
      if (reduced) drawStars(1.3);
    },
    boost(id) { boosts[id] = performance.now() + 9000; },
  };

  if (reduced) { drawStars(1.3); return api; } // single static frame

  const t0 = performance.now();
  function frame(now) {
    const el = (now - t0) / 1000;
    drawStars(el);
    // occasional shooting star
    if (!meteor && now >= nextMeteor) {
      meteor = {
        x: W * (0.15 + Math.random() * 0.7), y: -20,
        vx: (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 120),
        vy: 220 + Math.random() * 120, life: 0,
      };
    }
    if (meteor) {
      const dt = 1 / 60;
      meteor.life += dt;
      meteor.x += meteor.vx * dt;
      meteor.y += meteor.vy * dt;
      const fade = Math.max(0, 1 - meteor.life / 1.1);
      if (fade <= 0 || meteor.y > H + 40 || meteor.x < -60 || meteor.x > W + 60) {
        meteor = null;
        nextMeteor = now + 9000 + Math.random() * 9000;
      } else {
        const tx = meteor.x - meteor.vx * 0.35, ty = meteor.y - meteor.vy * 0.35;
        const grad = ctx.createLinearGradient(meteor.x, meteor.y, tx, ty);
        grad.addColorStop(0, `rgba(255, 255, 255, ${(0.9 * fade).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(meteor.x, meteor.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(meteor.x, meteor.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.9 * fade).toFixed(3)})`;
        ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return api;
}

/* ---------------- spaces list ---------------- */
async function renderSpaces() {
  const spaces = await store.spaces.all();
  spaces.sort((a, b) => b.createdAt - a.createdAt);
  const grid = $('spaces-grid');
  grid.innerHTML = '';
  $('spaces-empty').hidden = spaces.length > 0;

  for (const s of spaces) {
    const card = document.createElement('button');
    card.className = 'space-card';
    card.type = 'button';
    if (s.hue) card.style.setProperty('--hue', s.hue);
    const photo = s.photo
      ? `<img class="space-card-photo" src="${s.photo}" alt="">`
      : `<div class="space-card-photo placeholder" aria-hidden="true">✨</div>`;
    card.innerHTML = `${photo}<div class="space-card-body">
        <h2>${esc(s.name)}</h2>
        ${s.dates ? `<p class="space-card-dates">${esc(s.dates)}</p>` : ''}
        ${s.dedication ? `<p class="space-card-dedication">“${esc(s.dedication)}”</p>` : ''}
      </div>`;
    card.addEventListener('click', () => openSpace(s.id));
    grid.appendChild(card);
  }
}

async function openSpace(id, updateHash = true) {
  if (updateHash) {
    // Set the hash first so even an immediate reload lands back here.
    const h = '#/space/' + encodeURIComponent(id);
    if (location.hash !== h) location.hash = h;
  }
  currentSpaceId = id; // set before the awaits so the hashchange handler below skips the duplicate open
  const s = await store.spaces.get(id);
  if (!s) { goHome(); return; }
  pendingAttachments = [];
  await renderSpace();
  showView('space');
}

/* Remember the open space in the URL so a refresh (or back/forward) restores it. */
function spaceIdFromHash() {
  const m = location.hash.match(/^#\/space\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function goHome() {
  currentSpaceId = null;
  if (location.hash.startsWith('#/space/')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  await renderSpaces();
  await syncSky();
  showView('spaces');
}
window.addEventListener('hashchange', () => {
  const id = spaceIdFromHash();
  if (id) {
    if (id !== currentSpaceId) openSpace(id, false); // skip the duplicate from our own hash set
  } else goHome();
});

/* ---------------- space detail ---------------- */
async function renderSpace() {
  const s = await store.spaces.get(currentSpaceId);
  if (!s) { goHome(); return; }

  $('space-name').textContent = s.name;
  $('space-dates').textContent = s.dates || '';
  $('space-dates').style.display = s.dates ? '' : 'none';
  $('space-dedication').textContent = s.dedication ? `“${s.dedication}”` : '';
  const photo = $('space-photo');
  if (s.photo) { photo.src = s.photo; photo.hidden = false; photo.alt = s.name; }
  else photo.hidden = true;

  const msgs = await store.messages.bySpace(s.id);
  msgs.sort((a, b) => a.createdAt - b.createdAt);
  const tl = $('timeline');
  tl.innerHTML = '';
  $('timeline-empty').hidden = msgs.length > 0;

  for (const m of msgs) {
    const el = document.createElement('article');
    el.className = 'msg';
    const head = document.createElement('div');
    head.className = 'msg-head';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = fmtTime(m.createdAt);
    const del = document.createElement('button');
    del.className = 'msg-del';
    del.type = 'button';
    del.title = 'Delete this message';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      if (await appConfirm('Delete this message?', { confirmText: 'Delete', danger: true })) {
        await store.messages.del(m.id);
        renderSpace();
      }
    });
    head.append(time, del);
    el.appendChild(head);

    if (m.type === 'text') {
      const p = document.createElement('p');
      p.textContent = m.text;
      el.appendChild(p);
    } else if (m.type === 'photo') {
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = '📷 Photo';
      const img = document.createElement('img');
      img.src = m.dataUrl;
      img.alt = 'Attached photo';
      img.loading = 'lazy';
      el.append(label, img);
      if (m.text) { const p = document.createElement('p'); p.textContent = m.text; el.appendChild(p); }
    } else if (m.type === 'video') {
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = '🎬 Video';
      const v = document.createElement('video');
      v.src = m.dataUrl;
      v.controls = true;
      v.preload = 'metadata';
      el.append(label, v);
      if (m.text) { const p = document.createElement('p'); p.textContent = m.text; el.appendChild(p); }
    } else if (m.type === 'voice') {
      const label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = '🎙️ Voice note';
      const a = document.createElement('audio');
      a.src = m.dataUrl;
      a.controls = true;
      a.preload = 'metadata';
      el.append(label, a);
    }
    tl.appendChild(el);
  }
  tl.scrollTop = tl.scrollHeight;
  renderPending();
  await syncSky(); // highlight this star in the sky
}

/* ---------------- space dialog (create / edit) ---------------- */
let editingSpaceId = null;
let dialogPhotoDataUrl = null;

function openSpaceDialog(space) {
  editingSpaceId = space ? space.id : null;
  $('space-dialog-title').textContent = space ? 'Edit star' : 'New star';
  $('f-name').value = space ? space.name : '';
  $('f-dates').value = space ? (space.dates || '') : '';
  $('f-dedication').value = space ? (space.dedication || '') : '';
  $('f-photo').value = '';
  dialogPhotoDataUrl = space ? (space.photo || null) : null;
  const dlg = $('space-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else { dlg.setAttribute('open', ''); }
  setTimeout(() => $('f-name').focus(), 50);
}

function closeSpaceDialog() {
  const dlg = $('space-dialog');
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

/* ---------------- composer ---------------- */
function renderPending() {
  const box = $('pending');
  box.innerHTML = '';
  pendingAttachments.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'pending-item';
    const label = document.createElement('span');
    if (a.kind === 'photo') {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.alt = '';
      label.textContent = '📷 Photo';
      el.append(img, label);
    } else if (a.kind === 'video') {
      label.textContent = '🎬 Video attached';
      el.appendChild(label);
    } else {
      const au = document.createElement('audio');
      au.src = a.dataUrl;
      au.controls = true;
      label.textContent = '🎙️';
      el.append(label, au);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderPending(); });
    el.appendChild(rm);
    box.appendChild(el);
  });
}

async function sendMessage() {
  if (!currentSpaceId) return;
  const text = $('composer-text').value.trim();
  if (!text && pendingAttachments.length === 0) return;

  const preview = { text, kinds: pendingAttachments.map((a) => a.kind) };

  const now = Date.now();
  if (text) {
    await store.messages.put({ id: uid(), spaceId: currentSpaceId, type: 'text', text, createdAt: now });
  }
  for (const a of pendingAttachments) {
    await store.messages.put({
      id: uid(), spaceId: currentSpaceId, type: a.kind,
      text: '', dataUrl: a.dataUrl, mime: a.mime || '', createdAt: Date.now(),
    });
  }
  $('composer-text').value = '';
  pendingAttachments = [];
  const s = await store.spaces.get(currentSpaceId);
  const dest = {
    x: s && typeof s.starX === 'number' ? s.starX : 0.5,
    y: s && typeof s.starY === 'number' ? s.starY : 0.3,
    hue: (s && s.hue) || '255, 220, 180',
    name: (s && s.name) || 'the stars',
  };
  await playReleaseAnimation(preview, dest);
  if (sky && s) sky.boost(s.id); // the star glows brighter for a while
  await renderSpace();
  await syncSky();
}

/* ---------------- release-to-your-star send animation ----------------
 * Messages here are one-directional: they are not sent to anyone.
 * The message rests, then launches as a streak of light toward your
 * star — the one this space is named for — and makes it flare. */
function playReleaseAnimation(preview, dest) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
  dest = dest || { x: 0.5, y: 0.3, hue: '255, 220, 180', name: 'the stars' };
  const hue = dest.hue || '255, 220, 180';
  const starName = String(dest.name || 'the stars');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'stars-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'stars-canvas';

    const msg = document.createElement('div');
    msg.className = 'stars-message';
    if (preview.text) {
      const p = document.createElement('p');
      p.textContent = preview.text.length > 160 ? preview.text.slice(0, 160) + '…' : preview.text;
      msg.appendChild(p);
    }
    if (preview.kinds.length) {
      const icons = document.createElement('div');
      icons.className = 'stars-attachments';
      icons.textContent = preview.kinds.map((k) => (k === 'photo' ? '📷' : k === 'video' ? '🎬' : '🎙️')).join('  ');
      msg.appendChild(icons);
    }

    const caption = document.createElement('div');
    caption.className = 'stars-caption';
    const shortName = starName.length > 28 ? starName.slice(0, 28) + '…' : starName;
    caption.textContent = 'Sent to ' + shortName;

    overlay.appendChild(canvas);
    overlay.appendChild(msg);
    overlay.appendChild(caption);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const fit = () => {
      W = overlay.clientWidth; H = overlay.clientHeight;
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
    };
    fit();
    window.addEventListener('resize', fit);

    // star field; your star is the destination and stays fixed
    const stars = [];
    for (let i = 0; i < 90; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.6 + Math.random() * 1.8,
        vy: 0.02 + Math.random() * 0.08, // fraction of height per second, rising
        ph: Math.random() * Math.PI * 2,
        sp: 1 + Math.random() * 2,
      });
    }
    const target = { x: dest.x, y: dest.y, r: 2.4 };

    const lerp = (a, b, t) => a + (b - a) * t;

    const DUR = 3200;
    const t0 = performance.now();
    // timeline: 0–0.18 rest, 0.18–0.5 launch, 0.5–0.78 streak, 0.78–1 ignition
    const LAUNCH0 = 0.18, LAUNCH1 = 0.5, HIT = 0.78;

    function frame(t) {
      const el = (t - t0) / 1000;
      const p = Math.min(1, (t - t0) / DUR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // star field (your star is drawn separately, fixed at its sky position)
      for (const s of stars) {
        const y = ((((s.y - el * s.vy * 0.25) % 1) + 1) % 1);
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.ph + el * s.sp));
        ctx.beginPath();
        ctx.arc(s.x * W, y * H, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 250, 240, ${(tw * 0.9).toFixed(3)})`;
        ctx.fill();
      }

      const tx = target.x * W, ty = target.y * H;
      const releaseY = H * 0.5 - H * 0.42; // where the message hands off to the streak

      // --- the message: rests, then launches upward like it is being sent ---
      if (p < LAUNCH0) {
        msg.style.transform = 'translate(-50%, -50%)';
        msg.style.opacity = '1';
      } else if (p < LAUNCH1) {
        const lp = (p - LAUNCH0) / (LAUNCH1 - LAUNCH0);
        const e = lp * lp * lp; // accelerate
        msg.style.transform = `translate(-50%, calc(-50% + ${(-e * H * 0.42).toFixed(1)}px)) scale(${(1 - e * 0.25).toFixed(3)})`;
        msg.style.opacity = String(Math.max(0, 1 - e * 0.55));
      } else {
        msg.style.opacity = '0';
      }

      // --- streak of light: continues from the message up to the star ---
      if (p >= LAUNCH1 && p < HIT) {
        const sp = (p - LAUNCH1) / (HIT - LAUNCH1);
        const e = sp * sp;
        const sx = lerp(W * 0.5, tx, e);
        const sy = lerp(releaseY, ty, e);
        for (let k = 8; k >= 1; k--) { // comet trail
          const ek = Math.max(0, sp - k * 0.035);
          const ee = ek * ek;
          ctx.beginPath();
          ctx.arc(lerp(W * 0.5, tx, ee), lerp(releaseY, ty, ee), 3.2 * (1 - k / 10), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 244, 220, ${(0.28 * (1 - k / 9)).toFixed(3)})`;
          ctx.fill();
        }
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 14);
        grad.addColorStop(0, 'rgba(255, 252, 240, 1)');
        grad.addColorStop(0.4, 'rgba(255, 240, 200, 0.85)');
        grad.addColorStop(1, 'rgba(255, 240, 200, 0)');
        ctx.beginPath();
        ctx.arc(sx, sy, 14, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // --- ignition: your star flares in its own colour ---
      const lit = p >= HIT;
      const fp = lit ? Math.min(1, (p - HIT) / (1 - HIT)) : 0;
      ctx.save();
      if (lit) {
        const pulse = 1 + 0.35 * Math.sin(fp * Math.PI * 5) * (1 - fp * 0.5);
        ctx.shadowColor = `rgba(${hue}, 0.95)`;
        ctx.shadowBlur = 30;
        ctx.beginPath();
        ctx.arc(tx, ty, target.r * 2.8 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = '#fffdf4';
        ctx.fill();
        if (fp < 0.6) { // expanding rings at the moment of ignition
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.arc(tx, ty, 6 + fp * 150, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${hue}, ${(0.6 * (1 - fp / 0.6)).toFixed(3)})`;
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(tx, ty, 6 + fp * 90, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 255, 255, ${(0.5 * (1 - fp / 0.6)).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      } else {
        const tw = 0.6 + 0.4 * Math.sin(el * 3); // your star glimmers, waiting
        ctx.save();
        ctx.shadowColor = `rgba(${hue}, 0.9)`;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(tx, ty, target.r * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.85 * tw).toFixed(3)})`;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      caption.style.opacity = String(
        p < HIT ? 0 : Math.min(1, (p - HIT) / 0.12) * Math.max(0, 1 - Math.max(0, (p - 0.9) / 0.1))
      );
      overlay.style.opacity = String(p < 0.06 ? p / 0.06 : p > 0.9 ? 1 - (p - 0.9) / 0.1 : 1);

      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        window.removeEventListener('resize', fit);
        overlay.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

/* ---------------- star-birth animation (reverse supernova) ----------------
 * Naming a star ends with a little genesis: loose stardust across the sky
 * collapses inward — a supernova in reverse — ignites, and settles as your
 * new pinned star. */
function playStarBirthAnimation(star) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
  star = star || {};
  const hx = typeof star.x === 'number' ? star.x : 0.5;
  const hy = typeof star.y === 'number' ? star.y : 0.35;
  const hue = star.hue || '255, 220, 180';
  const name = String(star.name || 'your star');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'stars-overlay clear'; // the real sky shows through
    overlay.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.className = 'stars-canvas';
    const caption = document.createElement('div');
    caption.className = 'stars-caption';
    const shortName = name.length > 24 ? name.slice(0, 24) + '…' : name;
    caption.textContent = shortName + ' joins your sky';
    overlay.appendChild(canvas);
    overlay.appendChild(caption);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const fit = () => {
      W = overlay.clientWidth; H = overlay.clientHeight;
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
    };
    fit();
    window.addEventListener('resize', fit);

    // pre-rendered glow sprite: fast, no per-particle shadowBlur
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const sctx = sprite.getContext('2d');
    const sg = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    sg.addColorStop(0, 'rgba(255,255,255,1)');
    sg.addColorStop(0.3, `rgba(${hue},0.85)`);
    sg.addColorStop(1, `rgba(${hue},0)`);
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 64, 64);

    const tx0 = hx * W, ty0 = hy * H;
    const maxWH = Math.max(W, H);
    const P = [];
    for (let i = 0; i < 200; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = (0.3 + Math.random() * 0.7) * maxWH;
      P.push({
        sx: tx0 + Math.cos(ang) * dist,
        sy: ty0 + Math.sin(ang) * dist,
        size: 8 + Math.random() * 18,
        delay: Math.random() * 0.15,
        dur: 0.3 + Math.random() * 0.15,
        wob: Math.random() * Math.PI * 2,
        wsp: 2 + Math.random() * 4,
      });
    }

    const DUR = 3300;
    const t0 = performance.now();
    const IGNITE = 0.62;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    function frame(t) {
      const el = (t - t0) / 1000;
      const p = Math.min(1, (t - t0) / DUR);
      const tx = hx * W, ty = hy * H;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // --- phase 1: stardust collapses inward ---
      if (p < IGNITE) {
        for (const pt of P) {
          const lp = clamp01((p - pt.delay) / pt.dur);
          if (lp >= 1) continue; // absorbed into the core
          const e = lp * lp * lp; // accelerating inward, like gravity
          const wob = Math.sin(el * pt.wsp + pt.wob) * 26 * (1 - e);
          const px = pt.sx + (tx - pt.sx) * e - Math.sin(pt.wob) * wob * 0.3;
          const py = pt.sy + (ty - pt.sy) * e + Math.cos(pt.wob) * wob * 0.3;
          const sz = Math.max(2, pt.size * (1 - e * 0.7));
          ctx.globalAlpha = Math.min(1, 0.25 + e * 1.1);
          ctx.drawImage(sprite, px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1;
        const cp = clamp01((p - 0.3) / (IGNITE - 0.3)); // compressing core
        if (cp > 0) {
          const cr = 4 + cp * 26;
          ctx.globalAlpha = 0.35 + cp * 0.65;
          ctx.drawImage(sprite, tx - cr, ty - cr, cr * 2, cr * 2);
          ctx.globalAlpha = 1;
        }
      }

      // --- phase 2: ignition flash ---
      if (p >= IGNITE && p < 0.8) {
        const fp = (p - IGNITE) / 0.18;
        const fa = Math.sin(Math.min(1, fp) * Math.PI);
        const fr = Math.min(W, H) * 0.65 * (0.3 + 0.7 * fp);
        const fg = ctx.createRadialGradient(tx, ty, 0, tx, ty, fr);
        fg.addColorStop(0, `rgba(255,255,255,${(0.95 * fa).toFixed(3)})`);
        fg.addColorStop(0.35, `rgba(${hue},${(0.75 * fa).toFixed(3)})`);
        fg.addColorStop(1, `rgba(${hue},0)`);
        ctx.beginPath();
        ctx.arc(tx, ty, fr, 0, Math.PI * 2);
        ctx.fillStyle = fg;
        ctx.fill();
      }

      // --- phase 3: birth rings, then the new star settles ---
      if (p >= IGNITE) {
        for (let k = 0; k < 2; k++) {
          const rpk = clamp01((p - IGNITE - k * 0.08) / 0.3);
          if (rpk <= 0 || rpk >= 1) continue;
          ctx.beginPath();
          ctx.arc(tx, ty, 8 + rpk * Math.min(W, H) * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${hue}, ${(0.55 * (1 - rpk)).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.5, 3 - rpk * 2);
          ctx.stroke();
        }
        const sa = clamp01((p - 0.72) / 0.2); // matches the sky's own rendering
        if (sa > 0) {
          const haloR = 26;
          const hg = ctx.createRadialGradient(tx, ty, 0, tx, ty, haloR);
          hg.addColorStop(0, `rgba(${hue}, ${(0.5 * sa).toFixed(3)})`);
          hg.addColorStop(1, `rgba(${hue}, 0)`);
          ctx.beginPath();
          ctx.arc(tx, ty, haloR, 0, Math.PI * 2);
          ctx.fillStyle = hg;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${sa.toFixed(3)})`;
          ctx.fill();
        }
      }

      caption.style.opacity = String(
        p < 0.66 ? 0 : p < 0.76 ? (p - 0.66) / 0.1 : p > 0.9 ? Math.max(0, 1 - (p - 0.9) / 0.1) : 1
      );
      overlay.style.opacity = String(p < 0.9 ? 1 : 1 - (p - 0.9) / 0.1);

      if (p < 1) requestAnimationFrame(frame);
      else {
        window.removeEventListener('resize', fit);
        overlay.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

/* ---------------- supernova animation (star destruction) ----------------
 * Stars can't be deleted — they can only be destroyed. The star swells
 * white-hot, detonates in a super-bright flash, and hurls debris and
 * shockwaves across the sky before fading into a remnant glow. */
function playSupernovaAnimation(star) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
  star = star || {};
  const hx = typeof star.x === 'number' ? star.x : 0.5;
  const hy = typeof star.y === 'number' ? star.y : 0.35;
  const hue = star.hue || '255, 220, 180';
  const name = String(star.name || 'your star');
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'stars-overlay clear'; // the real sky shows through
    overlay.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.className = 'stars-canvas';
    const caption = document.createElement('div');
    caption.className = 'stars-caption';
    const shortName = name.length > 24 ? name.slice(0, 24) + '…' : name;
    caption.textContent = shortName + ' goes supernova';
    overlay.appendChild(canvas);
    overlay.appendChild(caption);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0;
    const fit = () => {
      W = overlay.clientWidth; H = overlay.clientHeight;
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
    };
    fit();
    window.addEventListener('resize', fit);

    // pre-rendered glow sprite: fast, no per-particle shadowBlur
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const sctx = sprite.getContext('2d');
    const sg = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    sg.addColorStop(0, 'rgba(255,255,255,1)');
    sg.addColorStop(0.3, `rgba(${hue},0.85)`);
    sg.addColorStop(1, `rgba(${hue},0)`);
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 64, 64);

    const tx0 = hx * W, ty0 = hy * H;
    const maxWH = Math.max(W, H);
    const minWH = Math.min(W, H);
    const D = [];
    for (let i = 0; i < 220; i++) {
      const ang = Math.random() * Math.PI * 2;
      D.push({
        dx: Math.cos(ang), dy: Math.sin(ang),
        speed: (0.25 + Math.random() * 0.75) * maxWH,
        size: 6 + Math.random() * 22,
        delay: 0.22 + Math.random() * 0.18,
        life: 0.45 + Math.random() * 0.25,
      });
    }

    const DUR = 3600;
    const t0 = performance.now();
    const DETONATE = 0.22;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    function frame(t) {
      const p = Math.min(1, (t - t0) / DUR);
      const tx = hx * W, ty = hy * H;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // --- phase 1: the star swells white-hot ---
      if (p < DETONATE + 0.08) {
        const sp = clamp01(p / DETONATE);
        const flicker = 0.9 + 0.1 * Math.sin(p * 90);
        const sr = (5 + sp * 46) * flicker;
        ctx.globalAlpha = Math.min(1, 0.5 + sp * 0.7);
        ctx.drawImage(sprite, tx - sr, ty - sr, sr * 2, sr * 2);
        ctx.globalAlpha = 1;
      }

      // --- phase 2: detonation — super bright ---
      if (p >= DETONATE && p < 0.62) {
        const rise = clamp01((p - DETONATE) / 0.06);
        const fall = clamp01((p - 0.3) / 0.32);
        const fa = Math.min(rise, 1 - fall * 0.85);
        if (fa > 0) {
          const fr = minWH * 0.8;
          const fg = ctx.createRadialGradient(tx, ty, 0, tx, ty, fr);
          fg.addColorStop(0, `rgba(255,255,255,${(0.98 * fa).toFixed(3)})`);
          fg.addColorStop(0.3, `rgba(255,255,255,${(0.85 * fa).toFixed(3)})`);
          fg.addColorStop(0.55, `rgba(${hue},${(0.55 * fa).toFixed(3)})`);
          fg.addColorStop(1, `rgba(${hue},0)`);
          ctx.beginPath();
          ctx.arc(tx, ty, fr, 0, Math.PI * 2);
          ctx.fillStyle = fg;
          ctx.fill();
          // white wash over everything at peak brilliance
          ctx.fillStyle = `rgba(255,252,245,${(0.22 * fa).toFixed(3)})`;
          ctx.fillRect(0, 0, W, H);
        }
      }

      // --- phase 3: debris hurled outward + shockwaves ---
      if (p >= DETONATE) {
        for (const d of D) {
          const lp = clamp01((p - d.delay) / d.life);
          if (lp <= 0 || lp >= 1) continue;
          const e = 1 - Math.pow(1 - lp, 3); // fast start, coasting
          const px = tx0 + d.dx * d.speed * e;
          const py = ty0 + d.dy * d.speed * e;
          const sz = Math.max(2, d.size * (1 - lp * 0.8));
          ctx.globalAlpha = (1 - lp) * 0.9;
          ctx.drawImage(sprite, px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1;
        for (let k = 0; k < 3; k++) {
          const rpk = clamp01((p - DETONATE - k * 0.07) / 0.5);
          if (rpk <= 0 || rpk >= 1) continue;
          ctx.beginPath();
          ctx.arc(tx, ty, 10 + rpk * maxWH * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = k === 1
            ? `rgba(255,255,255,${(0.5 * (1 - rpk)).toFixed(3)})`
            : `rgba(${hue},${(0.6 * (1 - rpk)).toFixed(3)})`;
          ctx.lineWidth = Math.max(0.5, 4.5 - rpk * 3.5);
          ctx.stroke();
        }
      }

      // --- phase 4: the remnant glow fades; the star is gone ---
      if (p > 0.62) {
        const rp = clamp01((p - 0.62) / 0.38);
        const rr = minWH * 0.3 * (0.4 + rp * 0.6);
        const rg = ctx.createRadialGradient(tx, ty, 0, tx, ty, rr);
        rg.addColorStop(0, `rgba(${hue},${(0.3 * (1 - rp)).toFixed(3)})`);
        rg.addColorStop(1, `rgba(${hue},0)`);
        ctx.beginPath();
        ctx.arc(tx, ty, rr, 0, Math.PI * 2);
        ctx.fillStyle = rg;
        ctx.fill();
      }

      caption.style.opacity = String(
        p < 0.3 ? 0 : p < 0.42 ? (p - 0.3) / 0.12 : p > 0.88 ? Math.max(0, 1 - (p - 0.88) / 0.12) : 1
      );
      overlay.style.opacity = String(p < 0.9 ? 1 : 1 - (p - 0.9) / 0.1);

      if (p < 1) requestAnimationFrame(frame);
      else {
        window.removeEventListener('resize', fit);
        overlay.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

/* ---------------- voice recording ---------------- */
let recorder = null, recChunks = [], recTimer = null, recStream = null;

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    appAlert('Voice recording is not available in this browser.');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    appAlert('Microphone access was denied.');
    return;
  }
  recChunks = [];
  let mime = '';
  if (window.MediaRecorder) {
    if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
    else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
  }
  recorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    try {
      const dataUrl = await fileToDataURL(blob);
      pendingAttachments.push({ kind: 'voice', dataUrl, mime: blob.type });
      renderPending();
    } catch (e) { appAlert('Could not save the recording.'); }
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null;
  };
  recorder.start();
  $('recorder').hidden = false;
  $('btn-record').classList.add('recording');
  const t0 = Date.now();
  $('rec-time').textContent = '0:00';
  recTimer = setInterval(() => { $('rec-time').textContent = fmtDur((Date.now() - t0) / 1000); }, 500);
}

function stopRecording() {
  if (recTimer) clearInterval(recTimer);
  $('recorder').hidden = true;
  $('btn-record').classList.remove('recording');
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
}

/* ---------------- export / import ---------------- */
function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Don't revoke the object URL on a timer: large backups (videos) can still be
  // streaming to the download manager when an early revoke would truncate them.
  setTimeout(() => a.remove(), 4000);
}

async function exportAll() {
  const spaces = await store.spaces.all();
  const messages = await store.messages.all();
  const payload = {
    app: 'starbound', version: 1,
    exportedAt: new Date().toISOString(),
    spaces, messages,
  };
  const json = JSON.stringify(payload);
  const mb = json.length / 1048576;
  const date = new Date().toISOString().slice(0, 10);
  if (mb > 25 && !(await appConfirm(`This backup is about ${mb.toFixed(0)} MB (videos can be large). Download anyway?`, { confirmText: 'Download' }))) return;
  download(`starbound-backup-${date}.json`, json);
}

function importAll(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { appAlert("Couldn't read that file. Is it a Starbound backup?"); return; }
    if (!data || !Array.isArray(data.spaces) || !Array.isArray(data.messages)) {
      appAlert('That file does not look like a Starbound backup.');
      return;
    }
    if (!(await appConfirm(`Restore this backup? It will replace everything here right now (${data.spaces.length} stars, ${data.messages.length} messages).`, { confirmText: 'Restore' }))) return;
    await tx('spaces', 'readwrite', (os) => reqAsPromise(os.clear()));
    await store.messages.clear();
    for (const s of data.spaces) {
      if (s && s.id) await store.spaces.put({ id: s.id, name: String(s.name || 'Untitled'), photo: s.photo || null, dates: s.dates || '', dedication: s.dedication || '', createdAt: s.createdAt || Date.now() });
    }
    for (const m of data.messages) {
      if (m && m.id && m.spaceId) await store.messages.put({ id: m.id, spaceId: m.spaceId, type: m.type || 'text', text: m.text || '', dataUrl: m.dataUrl || '', mime: m.mime || '', createdAt: m.createdAt || Date.now() });
    }
    currentSpaceId = null;
    await ensureStarPositions();
    await goHome();
    appAlert('Backup restored.');
  };
  reader.readAsText(file);
}

/* ---------------- wire up ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  sky = initStarfield();
  document.body.classList.add('in-space'); // dark theme for the whole app, applied immediately
  document.documentElement.classList.remove('boot-space', 'boot-spaces'); // app owns view visibility from here
  // Hide the wrong view synchronously: a refresh into a star must never flash the star list first.
  const bootHashId = spaceIdFromHash();
  $('view-spaces').hidden = !!bootHashId;
  $('view-space').hidden = !bootHashId;
  (async () => {
    await ensureStarPositions(); // older saves get a pinned star
    await renderSpaces();
    await syncSky();
    const deepId = spaceIdFromHash();
    if (deepId) openSpace(deepId, false);
    else showView('spaces');
  })();

  $('btn-new-space').addEventListener('click', () => openSpaceDialog(null));
  $('btn-cancel-space').addEventListener('click', closeSpaceDialog);
  $('f-photo').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    dialogPhotoDataUrl = await downscaleImage(await fileToDataURL(f));
  });

  $('space-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('f-name').value.trim();
    if (!name) return;
    if (editingSpaceId) {
      const s = await store.spaces.get(editingSpaceId);
      Object.assign(s, {
        name,
        dates: $('f-dates').value.trim(),
        dedication: $('f-dedication').value.trim(),
        photo: dialogPhotoDataUrl,
      });
      await store.spaces.put(s);
      closeSpaceDialog();
      await renderSpace();
    } else {
      const rec = {
        id: uid(), name,
        dates: $('f-dates').value.trim(),
        dedication: $('f-dedication').value.trim(),
        photo: dialogPhotoDataUrl,
        ...pickStarPosition(await store.spaces.all()),
        hue: pickHue(),
        createdAt: Date.now(),
      };
      await store.spaces.put(rec);
      closeSpaceDialog();
      await renderSpaces();
      await playStarBirthAnimation({ x: rec.starX, y: rec.starY, hue: rec.hue, name: rec.name });
      await syncSky();
      openSpace(rec.id);
    }
  });

  $('btn-back').addEventListener('click', () => {
    goHome();
  });

  $('btn-edit-space').addEventListener('click', async () => {
    const s = await store.spaces.get(currentSpaceId);
    if (s) openSpaceDialog(s);
  });

  $('btn-delete-space').addEventListener('click', async () => {
    const s = await store.spaces.get(currentSpaceId);
    if (!s) return;
    if (!(await appConfirm(`Destroy the star “${s.name}”? It will go supernova — one last blaze of light — and then be gone, along with all its messages. This cannot be undone.`, { confirmText: 'Destroy', danger: true }))) return;
    await playSupernovaAnimation({
      x: typeof s.starX === 'number' ? s.starX : 0.5,
      y: typeof s.starY === 'number' ? s.starY : 0.35,
      hue: s.hue || '255, 220, 180',
      name: s.name,
    });
    const msgs = await store.messages.bySpace(s.id);
    for (const m of msgs) await store.messages.del(m.id);
    await store.spaces.del(s.id);
    await goHome();
  });

  $('btn-send').addEventListener('click', sendMessage);
  $('composer-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMessage();
  });

  $('btn-attach-photo').addEventListener('click', () => $('file-photo').click());
  $('btn-attach-video').addEventListener('click', () => $('file-video').click());
  $('file-photo').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const dataUrl = await downscaleImage(await fileToDataURL(f));
    pendingAttachments.push({ kind: 'photo', dataUrl, mime: 'image/jpeg' });
    renderPending();
  });
  $('file-video').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 200 * 1048576 && !(await appConfirm('This video is over 200 MB and will be stored on your device. Continue?', { confirmText: 'Continue' }))) return;
    pendingAttachments.push({ kind: 'video', dataUrl: await fileToDataURL(f), mime: f.type });
    renderPending();
  });

  $('btn-record').addEventListener('click', () => {
    if ($('recorder').hidden) startRecording();
    else stopRecording();
  });
  $('btn-stop-rec').addEventListener('click', stopRecording);

  $('btn-export').addEventListener('click', exportAll);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importAll(f);
  });
});
