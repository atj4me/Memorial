# Memorial

A private memorial-messaging web app. Create a space per loved one and keep
sending them messages — text, photos, video, voice notes — with no reply
expected. Inspired by the memorial-messaging idea in the film *Taxi Driver*.

**Live app:** https://atj4me.github.io/memorial/

## Privacy model — read this first

The repo is **public** (GitHub Pages on a free account requires a public
repository), but **all memorial content lives only in the visitor's own
browser**, in IndexedDB on their device:

- There is no backend, no accounts, no sign-in, and no analytics.
- The page makes zero network requests after it loads — it works offline.
- Everything you write, upload, or record is stored locally via IndexedDB and
  never leaves your device.
- The hosted site is just the empty app shell (HTML/CSS/JS). If you open it
  in a different browser or on a different device, your spaces and messages
  will not be there — that is by design.
- **Backup is your responsibility:** use the Export button to download your
  full dataset as JSON (media embedded as data URLs), and Import to restore
  it. Keep the backup file somewhere safe.

If you want someone else to use the app, point them at the live URL — they
get their own private, local-only copy. Nothing is shared between visitors.

## Files

- `index.html` — app shell (spaces list, space detail, composer, dialogs)
- `styles.css` — calm, warm, minimal styling; system fonts; mobile-friendly
- `app.js` — vanilla JS, no dependencies: IndexedDB persistence, MediaRecorder
  voice notes, JSON export/import

## Running locally

Any static server works, e.g. `python3 -m http.server` in this directory,
then open http://localhost:8000. (Voice recording needs a secure context —
`localhost` counts, as does the HTTPS GitHub Pages URL.)
