# Starbound

A private sky for the words you still need to say — to those you've lost,
a chapter of your life, or just yourself. Name a star, then keep sending it
text, photos, videos and voice notes. Nothing is ever sent anywhere and no
reply is expected; each entry simply flies to your star.

**Live app:** https://atj4me.github.io/Starbound/

## What it is

- **Sky map** — an endless, pannable/zoomable starfield. Tap any unnamed star
  to claim it; tap your star to open it. Your stars form a constellation.
  A list view is one tap away.
- **Star birth & supernova** — naming a star plays a reverse-supernova genesis
  animation; destroying one plays a supernova. The UI fades away so the sky
  owns the moment.
- **Send ritual** — sending a message launches it as a streak of light to
  your star, which flares in its own colour: "Sent to {name}".
- **PWA** — installable, works offline (service worker + manifest).
- **Dark cosmic theme** throughout, no light surfaces.

## Privacy model — read this first

All content lives only in the visitor's own browser, in IndexedDB on their
device:

- There is no backend, no accounts, no sign-in, and no analytics.
- The page makes zero network requests after it loads — it works offline.
- Everything you write, upload, or record is stored locally via IndexedDB and
  never leaves your device. The hosted site is just the empty app shell
  (HTML/CSS/JS). If you open it in a different browser or on a different
  device, your stars and entries will not be there — that is by design.
- **Backup is your responsibility:** use the Backup button to download your
  full dataset as JSON (media embedded as data URLs), and Restore to bring
  it back. Keep the backup file somewhere safe.
- **Google Drive sync (optional):** tap the cloud button in the top bar to
  sign in with Google and keep your sky in sync across devices. Your data
  is stored in a hidden folder only Starbound can see, inside your own
  Google Drive — no one else can access it. Nothing is shared with anyone.

If you want someone else to use the app, point them at the live URL — they
get their own private, local-only copy. Nothing is shared between visitors.

## Files

- `index.html` — app shell (sky map, list, star detail, composer, dialogs)
- `styles.css` — dark cosmic styling; system fonts; mobile-friendly
- `app.js` — vanilla JS: IndexedDB persistence, MediaRecorder voice notes,
  JSON backup/restore, canvas starfields, sky-map engine, birth/supernova/send
  animations
- `sw.js` — service worker (PWA install + offline)
- `manifest.webmanifest`, `icons/` — PWA manifest, icons and favicon
- `vendor/sweetalert2.min.js` — self-hosted dialogs (no CDN; stays on-device)

## Running locally

Any static server works, e.g. `python3 -m http.server` in this directory,
then open http://localhost:8000. (Voice recording needs a secure context —
`localhost` counts, as does the HTTPS GitHub Pages URL.)
