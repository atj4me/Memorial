/* Starbound — optional Google Drive sync.
 *
 * Each signed-in user syncs their own sky to a hidden appDataFolder inside
 * THEIR OWN Google Drive. Nobody else can see it — not even other users of
 * this app. Google Identity Services is lazy-loaded only when the Drive
 * button is tapped, so the app makes zero Google requests until opt-in.
 *
 * Sync model: merge by record ID. Stars and messages are immutable once
 * written and carry unique IDs, so two devices can only ever add — never
 * clobber. Deletions travel as tombstones (see noteDeletions). Merge is
 * idempotent and commutative, so sync converges no matter the order.
 */

const DRIVE_CLIENT_ID = ''; // <-- set at build time; the Drive button stays hidden until set
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE = 'starbound-sync.json';
const DRIVE_LS_LINKED = 'starbound-drive-linked';
const DRIVE_LS_LAST = 'starbound-drive-last';

const driveReady = () => typeof DRIVE_CLIENT_ID === 'string' && DRIVE_CLIENT_ID.length > 8;

let gisLoading = null;
let driveTokenClient = null;
let driveAccessToken = null;
let driveTokenExpiry = 0;
let driveFileId = null;
let drivePushTimer = null;
let drivePushSuppressed = false;
let driveSyncing = false;

function driveDeviceId() {
  let id = null;
  try { id = localStorage.getItem('starbound-device-id'); } catch (_) {}
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('starbound-device-id', id); } catch (_) {}
  }
  return id;
}

/* ---------------- sign-in ---------------- */

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection.'));
    document.head.appendChild(s);
  });
  return gisLoading;
}

// Interactive sign-in (needs a user tap — browsers block popups otherwise).
function driveSignIn() {
  return loadGis().then(() => new Promise((resolve, reject) => {
    try {
      driveTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp && resp.access_token) {
            driveAccessToken = resp.access_token;
            driveTokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
            try { localStorage.setItem(DRIVE_LS_LINKED, '1'); } catch (_) {}
            updateDriveButton();
            resolve(true);
          } else {
            reject(new Error('Google sign-in did not return a token.'));
          }
        },
        error_callback: () => reject(new Error('Google sign-in failed.')),
      });
      driveTokenClient.requestAccessToken();
    } catch (e) {
      reject(e);
    }
  }));
}

function driveSignedIn() {
  return !!driveAccessToken && Date.now() < driveTokenExpiry - 60000;
}

function driveSignOut() {
  if (driveAccessToken && window.google && window.google.accounts) {
    try { window.google.accounts.oauth2.revoke(driveAccessToken, () => {}); } catch (_) {}
  }
  driveAccessToken = null;
  driveFileId = null;
  try { localStorage.removeItem(DRIVE_LS_LINKED); } catch (_) {}
  updateDriveButton();
}

/* ---------------- Drive API ---------------- */

async function driveFetch(path, opts = {}) {
  if (!driveSignedIn()) throw new Error('not-signed-in');
  const res = await fetch('https://www.googleapis.com' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + driveAccessToken, ...(opts.headers || {}) },
  });
  if (res.status === 401 || res.status === 403) {
    driveAccessToken = null;
    updateDriveButton();
    throw new Error('not-signed-in');
  }
  if (!res.ok) throw new Error('drive-' + res.status);
  return res;
}

async function driveFindFile() {
  if (driveFileId) return driveFileId;
  const q = encodeURIComponent(`name = '${DRIVE_FILE}' and trashed = false`);
  const res = await driveFetch(`/drive/v3/files?q=${q}&spaces=appDataFolder&fields=files(id)`);
  const j = await res.json();
  driveFileId = j.files && j.files.length ? j.files[0].id : null;
  return driveFileId;
}

/* ---------------- snapshot / merge ---------------- */

async function buildSnapshot() {
  const [spaces, messages, meta] = await Promise.all([
    store.spaces.all(), store.messages.all(), store.meta.get('sync'),
  ]);
  return {
    app: 'starbound',
    version: 1,
    deviceId: driveDeviceId(),
    updatedAt: Date.now(),
    spaces: spaces || [],
    messages: messages || [],
    deletedStars: (meta && meta.deletedStars) || {},
    deletedMessages: (meta && meta.deletedMessages) || {},
  };
}

// Pure merge: union by ID, tombstones win. Safe to run in any order.
function mergeSyncData(local, remote) {
  const deletedStars = { ...(local.deletedStars || {}), ...(remote.deletedStars || {}) };
  const deletedMessages = { ...(local.deletedMessages || {}), ...(remote.deletedMessages || {}) };
  const deadStars = new Set(Object.keys(deletedStars));
  const deadMsgs = new Set(Object.keys(deletedMessages));

  const starMap = new Map();
  for (const s of local.spaces || []) {
    if (s && s.id && !deadStars.has(s.id)) starMap.set(s.id, s);
  }
  for (const s of remote.spaces || []) {
    if (!s || !s.id || deadStars.has(s.id)) continue;
    if (!starMap.has(s.id)) starMap.set(s.id, s);
  }

  const msgMap = new Map();
  for (const m of local.messages || []) {
    if (!m || !m.id || deadMsgs.has(m.id) || deadStars.has(m.spaceId)) continue;
    msgMap.set(m.id, m);
  }
  for (const m of remote.messages || []) {
    if (!m || !m.id || deadMsgs.has(m.id) || deadStars.has(m.spaceId)) continue;
    if (!msgMap.has(m.id)) msgMap.set(m.id, m);
  }

  const spaces = [...starMap.values()];
  const messages = [...msgMap.values()];
  return {
    spaces,
    messages,
    deletedStars,
    deletedMessages,
    spaceIds: new Set(spaces.map((s) => s.id)),
    messageIds: new Set(messages.map((m) => m.id)),
  };
}

async function applyMerged(merged) {
  drivePushSuppressed = true;
  try {
    const [localSpaces, localMessages] = await Promise.all([store.spaces.all(), store.messages.all()]);
    const haveStars = new Set(localSpaces.map((s) => s.id));
    const haveMsgs = new Set(localMessages.map((m) => m.id));
    for (const s of merged.spaces) if (!haveStars.has(s.id)) await store.spaces.put(s);
    for (const s of localSpaces) if (!merged.spaceIds.has(s.id)) await store.spaces.del(s.id);
    for (const m of merged.messages) if (!haveMsgs.has(m.id)) await store.messages.put(m);
    for (const m of localMessages) if (!merged.messageIds.has(m.id)) await store.messages.del(m.id);
    await store.meta.put({ key: 'sync', deletedStars: merged.deletedStars, deletedMessages: merged.deletedMessages });
  } finally {
    drivePushSuppressed = false;
  }
  if (typeof renderSpaces === 'function') await renderSpaces();
  if (typeof currentSpaceId !== 'undefined' && currentSpaceId && !merged.spaceIds.has(currentSpaceId)) {
    currentSpaceId = null;
    if (typeof goHome === 'function') await goHome();
  } else if (typeof currentSpaceId !== 'undefined' && currentSpaceId && typeof renderSpace === 'function') {
    await renderSpace();
  }
}

async function drivePush() {
  const snap = await buildSnapshot();
  const body = JSON.stringify(snap);
  const id = await driveFindFile();
  if (id) {
    await driveFetch(`/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } else {
    const boundary = 'starbound' + Date.now().toString(36);
    const meta = JSON.stringify({ name: DRIVE_FILE, parents: ['appDataFolder'] });
    const res = await driveFetch('/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body:
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n` +
        `--${boundary}--`,
    });
    const j = await res.json();
    if (j && j.id) driveFileId = j.id;
  }
  try { localStorage.setItem(DRIVE_LS_LAST, String(Date.now())); } catch (_) {}
  updateDriveButton();
}

async function drivePull() {
  const id = await driveFindFile();
  if (!id) return 'empty';
  const res = await driveFetch(`/drive/v3/files/${id}?alt=media`);
  const remote = await res.json();
  if (!remote || remote.app !== 'starbound') return 'empty';
  const local = await buildSnapshot();
  await applyMerged(mergeSyncData(local, remote));
  return 'ok';
}

async function driveSyncNow() {
  if (driveSyncing) return 'busy';
  driveSyncing = true;
  try {
    if (!driveSignedIn()) await driveSignIn();
    const pulled = await drivePull();
    await drivePush();
    return pulled;
  } finally {
    driveSyncing = false;
  }
}

/* ---------------- auto-push on local changes ---------------- */

function scheduleDrivePush() {
  if (!driveReady() || !driveSignedIn() || drivePushSuppressed) return;
  clearTimeout(drivePushTimer);
  drivePushTimer = setTimeout(() => {
    drivePush().catch(() => { /* offline/token expired — next change or tap retries */ });
  }, 8000);
}
function markDirty() { scheduleDrivePush(); }

// Record deletions as tombstones so they propagate to other devices.
async function noteDeletions(starIds, msgIds) {
  try {
    const meta = (await store.meta.get('sync')) || { key: 'sync', deletedStars: {}, deletedMessages: {} };
    meta.deletedStars = meta.deletedStars || {};
    meta.deletedMessages = meta.deletedMessages || {};
    const now = Date.now();
    for (const id of starIds || []) meta.deletedStars[id] = now;
    for (const id of msgIds || []) meta.deletedMessages[id] = now;
    for (const k of ['deletedStars', 'deletedMessages']) {
      const ids = Object.keys(meta[k]).sort((a, b) => meta[k][a] - meta[k][b]);
      while (ids.length > 500) delete meta[k][ids.shift()];
    }
    await store.meta.put(meta);
  } catch (_) {}
}

// Wrap every store write so any local change schedules a push — no per-site hooks.
(function wrapStore() {
  if (typeof store === 'undefined') return;
  for (const s of [store.spaces, store.messages]) {
    for (const m of ['put', 'del', 'clear']) {
      if (typeof s[m] !== 'function') continue;
      const orig = s[m].bind(s);
      s[m] = (...args) => orig(...args).then((r) => { scheduleDrivePush(); return r; });
    }
  }
})();

/* ---------------- UI ---------------- */

function driveLastSyncText() {
  let last = 0;
  try { last = Number(localStorage.getItem(DRIVE_LS_LAST) || 0); } catch (_) {}
  if (!last) return 'never';
  const d = new Date(last);
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('en-US', opts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', opts);
}

function driveIsLinked() {
  try { return localStorage.getItem(DRIVE_LS_LINKED) === '1'; } catch (_) { return false; }
}

function updateDriveButton() {
  const btn = document.getElementById('btn-drive');
  if (!btn) return;
  const linked = driveIsLinked();
  btn.classList.toggle('drive-off', linked && !driveSignedIn());
  btn.title = !linked
    ? 'Sync with Google Drive'
    : (driveSignedIn() ? 'Drive sync — last synced ' + driveLastSyncText() : 'Drive sync — tap to reconnect');
}

function driveSwal() { return window.Sweetalert2 || window.Swal; }

async function showDriveDialog() {
  const SwalLib = driveSwal();
  if (!SwalLib) return;
  const dark = {
    background: '#141a33', color: '#f5efe2', backdrop: 'rgba(4, 6, 16, 0.72)',
    confirmButtonColor: '#7c5cff', customClass: { popup: 'sb-swal' },
  };

  if (!driveIsLinked() || !driveSignedIn()) {
    const r = await SwalLib.fire({
      ...dark,
      title: 'Sync with Google Drive',
      html: '<p class="drive-blurb">Keep your sky in sync across devices. Everything is stored in a hidden folder only Starbound can see, inside <strong>your own</strong> Google Drive — no one else can access it.</p>',
      confirmButtonText: 'Sign in with Google',
      showCancelButton: true,
      cancelButtonText: 'Not now',
    });
    if (!r.isConfirmed) return;
    SwalLib.fire({ ...dark, title: 'Connecting…', allowOutsideClick: false, showConfirmButton: false, didOpen: () => SwalLib.showLoading() });
    try {
      await driveSyncNow();
      await SwalLib.fire({ ...dark, title: 'In sync', html: `<p class="drive-blurb">Your sky is synced with your Google Drive. Last synced ${driveLastSyncText()}.</p>`, confirmButtonText: 'Done' });
    } catch (e) {
      await SwalLib.fire({ ...dark, title: 'Could not sync', html: '<p class="drive-blurb">Google Drive could not be reached. Check your connection and try again.</p>', confirmButtonText: 'OK' });
    }
    return;
  }

  const r = await SwalLib.fire({
    ...dark,
    title: 'Google Drive sync',
    html: `<p class="drive-blurb">Last synced ${driveLastSyncText()}. Your data lives in a hidden Starbound folder in your own Drive.</p>`,
    confirmButtonText: 'Sync now',
    showDenyButton: true,
    denyButtonText: 'Sign out',
    denyButtonColor: '#a33',
    showCancelButton: true,
    cancelButtonText: 'Close',
  });
  if (r.isConfirmed) {
    SwalLib.fire({ ...dark, title: 'Syncing…', allowOutsideClick: false, showConfirmButton: false, didOpen: () => SwalLib.showLoading() });
    try {
      await driveSyncNow();
      await SwalLib.fire({ ...dark, title: 'In sync', html: `<p class="drive-blurb">Last synced ${driveLastSyncText()}.</p>`, confirmButtonText: 'Done' });
    } catch (e) {
      await SwalLib.fire({ ...dark, title: 'Could not sync', html: '<p class="drive-blurb">Google Drive could not be reached. Check your connection and try again.</p>', confirmButtonText: 'OK' });
    }
  } else if (r.isDenied) {
    driveSignOut();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (!driveReady()) return;
  const btn = document.getElementById('btn-drive');
  if (btn) {
    btn.hidden = false;
    btn.addEventListener('click', showDriveDialog);
  }
  updateDriveButton();
});

// Pull when returning to the app so another device's changes appear.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && driveReady() && driveSignedIn()) {
    drivePull()
      .then((r) => { if (r === 'ok') drivePush().catch(() => {}); })
      .catch(() => {});
  }
});

// Node test hook (no-op in browsers).
if (typeof module !== 'undefined' && module.exports) module.exports = { mergeSyncData };
