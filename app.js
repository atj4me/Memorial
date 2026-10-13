/* Starbound — private letters to the stars.
 * Vanilla JS, no dependencies, no network calls. All data in IndexedDB, local only. */
'use strict';

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

  const seed = () => {
    stars = [];
    const n = Math.round(Math.min(220, Math.max(120, (W * H) / 12000)));
    for (let i = 0; i < n; i++) {
      const hero = Math.random() < 0.1;
      const blinker = !hero && Math.random() < 0.22; // stars that visibly blink
      const tint = Math.random();
      stars.push({
        x: Math.random(), // fractional: stable across resizes (URL bar show/hide)
        y: Math.random(),
        r: hero ? 1.6 + Math.random() * 1.2 : blinker ? 1 + Math.random() * 1.2 : 0.6 + Math.random() * 1.1,
        base: blinker ? 0.5 : 0.25 + Math.random() * 0.5,
        amp: blinker ? 0.5 : 0.2 + Math.random() * 0.45,
        ph: Math.random() * Math.PI * 2,
        sp: blinker ? 1.5 + Math.random() * 2.5 : 0.6 + Math.random() * 2.2,
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
  }

  if (reduced) { drawStars(1.3); return; } // single static frame

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

async function openSpace(id) {
  currentSpaceId = id;
  pendingAttachments = [];
  await renderSpace();
  showView('space');
}

/* ---------------- space detail ---------------- */
async function renderSpace() {
  const s = await store.spaces.get(currentSpaceId);
  if (!s) { showView('spaces'); return; }

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
      if (confirm('Delete this message?')) {
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
}

/* ---------------- space dialog (create / edit) ---------------- */
let editingSpaceId = null;
let dialogPhotoDataUrl = null;

function openSpaceDialog(space) {
  editingSpaceId = space ? space.id : null;
  $('space-dialog-title').textContent = space ? 'Edit space' : 'New space';
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
  await playReleaseAnimation(preview);
  await renderSpace();
}

/* ---------------- release-to-stars send animation ----------------
 * Messages here are one-directional: they are not sent to anyone.
 * The message rests, then launches upward as a streak of light and
 * ignites one random star — your words join the sky. */
function playReleaseAnimation(preview) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }
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
    caption.textContent = 'Released to the stars';

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

    // star field; one random star is the destination and stays fixed
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
    const target = stars[(Math.random() * stars.length) | 0];
    target.vy = 0;
    target.r = Math.max(target.r, 1.5);
    target.y = Math.min(target.y, 0.55); // destination in the upper sky

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

      // star field (destination star drawn separately, fixed)
      for (const s of stars) {
        if (s === target) continue;
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

      // --- ignition: the destination star lights up ---
      const lit = p >= HIT;
      const fp = lit ? Math.min(1, (p - HIT) / (1 - HIT)) : 0;
      ctx.save();
      if (lit) {
        const pulse = 1 + 0.35 * Math.sin(fp * Math.PI * 5) * (1 - fp * 0.5);
        ctx.shadowColor = 'rgba(255, 236, 180, 0.95)';
        ctx.shadowBlur = 26;
        ctx.beginPath();
        ctx.arc(tx, ty, target.r * 2.6 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = '#fff8e6';
        ctx.fill();
        if (fp < 0.6) { // expanding ring at the moment of ignition
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.arc(tx, ty, 6 + fp * 130, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 240, 200, ${(0.55 * (1 - fp / 0.6)).toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      } else {
        const tw = 0.6 + 0.4 * Math.sin(el * 3); // the chosen star glimmers, waiting
        ctx.beginPath();
        ctx.arc(tx, ty, target.r * 1.3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 250, 240, ${(0.75 * tw).toFixed(3)})`;
        ctx.fill();
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

/* ---------------- voice recording ---------------- */
let recorder = null, recChunks = [], recTimer = null, recStream = null;

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Voice recording is not available in this browser.');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Microphone access was denied.');
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
    } catch (e) { alert('Could not save the recording.'); }
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
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
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
  if (mb > 25 && !confirm(`This backup is about ${mb.toFixed(0)} MB (videos can be large). Download anyway?`)) return;
  download(`starbound-backup-${date}.json`, json);
}

function importAll(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (e) { alert('That file is not valid JSON.'); return; }
    if (!data || !Array.isArray(data.spaces) || !Array.isArray(data.messages)) {
      alert('That file does not look like a Starbound backup.');
      return;
    }
    if (!confirm(`Import this backup? It will REPLACE everything currently here (${data.spaces.length} spaces, ${data.messages.length} messages).`)) return;
    await tx('spaces', 'readwrite', (os) => reqAsPromise(os.clear()));
    await store.messages.clear();
    for (const s of data.spaces) {
      if (s && s.id) await store.spaces.put({ id: s.id, name: String(s.name || 'Untitled'), photo: s.photo || null, dates: s.dates || '', dedication: s.dedication || '', createdAt: s.createdAt || Date.now() });
    }
    for (const m of data.messages) {
      if (m && m.id && m.spaceId) await store.messages.put({ id: m.id, spaceId: m.spaceId, type: m.type || 'text', text: m.text || '', dataUrl: m.dataUrl || '', mime: m.mime || '', createdAt: m.createdAt || Date.now() });
    }
    currentSpaceId = null;
    await renderSpaces();
    showView('spaces');
    alert('Backup imported.');
  };
  reader.readAsText(file);
}

/* ---------------- wire up ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  initStarfield();
  document.body.classList.add('in-space'); // dark theme for the whole app, applied immediately
  showView('spaces');
  renderSpaces();

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
      const s = {
        id: uid(), name,
        dates: $('f-dates').value.trim(),
        dedication: $('f-dedication').value.trim(),
        photo: dialogPhotoDataUrl,
        createdAt: Date.now(),
      };
      await store.spaces.put(s);
      closeSpaceDialog();
      await renderSpaces();
      openSpace(s.id);
    }
  });

  $('btn-back').addEventListener('click', async () => {
    currentSpaceId = null;
    await renderSpaces();
    showView('spaces');
  });

  $('btn-edit-space').addEventListener('click', async () => {
    const s = await store.spaces.get(currentSpaceId);
    if (s) openSpaceDialog(s);
  });

  $('btn-delete-space').addEventListener('click', async () => {
    const s = await store.spaces.get(currentSpaceId);
    if (!s) return;
    if (!confirm(`Delete the space “${s.name}” and all its messages? This cannot be undone.`)) return;
    const msgs = await store.messages.bySpace(s.id);
    for (const m of msgs) await store.messages.del(m.id);
    await store.spaces.del(s.id);
    currentSpaceId = null;
    await renderSpaces();
    showView('spaces');
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
    if (f.size > 200 * 1048576 && !confirm('This video is over 200 MB and will be stored on your device. Continue?')) return;
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
