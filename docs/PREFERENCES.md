# Local settings persistence

Knightlight has one settings profile per workspace. The bundled browser is the caller; these endpoints retain the app's localhost Host/Origin checks. There is no account or cloud sync. The existing unversioned API gains additive endpoints.

- `GET /api/preferences` returns `null` before the first save, otherwise `{ "updated_at": 1790000000000, "values": { ... } }`.
- `PUT /api/preferences` replaces the settings snapshot and returns the saved snapshot after an atomic disk write. Every known field is sent by the frontend. `POST` accepts the same idempotent operation for a `sendBeacon` flush during page close.
- `GET /api/preferences/bootstrap.js` delivers the saved snapshot before the normal application scripts initialize. It sets `window.knightlightSavedPreferences` to the same object or `null`. It is uncached and has `Cross-Origin-Resource-Policy: same-origin` and `nosniff` headers.

The client validates known settings, then batches slider activity for 120 ms. It flushes pending changes with a keepalive request or page-close beacon. `updated_at` is a safe integer ordering token: the maximum of the current Unix time in milliseconds and the preceding known token plus one. Older writes return 409 so delayed requests cannot roll back a newer save; identical retries return 200 without another write. This is a last-edit-wins profile for one local user; separate windows do not merge simultaneous edits to different fields.

Invalid fields, types, enum values and numeric ranges return 400. Write failures return 503 and preserve the prior in-memory snapshot. Errors use the app's `{ "error": { "message": "..." } }` shape. GET and mutation responses use `Cache-Control: no-store`. This bounded single resource has no collection/pagination.

Settings are stored in `data/preferences.json` using the existing atomic replacement and preceding-record backup mechanism. Browser preferences from older releases seed the profile when no disk snapshot exists. Saved disk settings take precedence over an old browser cache. Only an explicitly pending, newer browser change can recover over an older disk snapshot, and it is retried on load or reconnect. Existing automatic narration defaults remain unchanged.

`npm run test:preferences` uses a disposable workspace and muted Chromium to check migration, actual control changes, a complete browser/server restart with a new origin/port and empty browser storage, immediate window close, stale saves, disk-error reporting/recovery, and resetting defaults. Rust tests validate inputs, idempotency, ordering, disk round trips and preservation after a failed write.
