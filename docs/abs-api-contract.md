# ABS API contract

This document lists every Audiobookshelf (ABS) API endpoint that Pholia depends on, the response shape it expects, and what happens when an endpoint returns something different.

This is the contract a real ABS server satisfies, and the contract any ABS-shim implementation (e.g. a custom backend wrapping a different data source) must also satisfy. If Pholia "looks broken" on a particular server — empty tabs, 404 cover requests, silent failures — this list is the first thing to check.

## Auth

All endpoints accept both:
- `?token=<jwt>` query parameter (Pholia's default)
- `Authorization: Bearer <jwt>` header

**Pholia uses `?token=` everywhere.** This is deliberate — the Authorization header triggers a CORS preflight, and ABS's CORS setup has historically been fragile around credentials + wildcard headers. Query-param auth means GET requests need no preflight at all. See `CLAUDE.md` → CORS saga.

POST requests (sync, session) still need `Content-Type: application/json`, so they preflight, but that's been stable.

The JWT comes from `POST /login` with `{ username, password }`, returns `{ user: { token } }`.

## Endpoints

### `GET /api/libraries`

List the user's libraries.

**Response:**
```json
{ "libraries": [ { "id": "<id>", "name": "...", "mediaType": "book" | "podcast" }, ... ] }
```

**Used by:** App init — populates the library selector and picks a default.

**Failure mode:** Login completes but Pholia shows no content. Library selector is empty.

### `GET /api/libraries/:id/personalized`

The Home view's main data source. Returns "shelves" — recently-listened-to, recent series, newest authors, etc.

**Response:** array of shelves:
```json
[
  {
    "label": "Continue Listening",
    "type": "book" | "episode" | "series" | "authors",
    "entities": [ ... ]
  },
  ...
]
```

**Entity shapes per `type`:**
- `book` / `episode`: full library item — `{ id, media: { metadata: { title, authorName, ... }, ... }, mediaProgress: { progress } }`
- `series`: `{ id, name, books: [ { id | libraryItemId, ... } ], numBooks }`
- `authors`: `{ id, name, numBooks, imagePath? }`

**Critical:** Pholia branches on `section.type` to compute:
- Cover URL — book/episode uses `entity.id`; series uses `entity.books[0].id`; authors uses `/api/authors/:id/image`.
- Display title — book/episode uses `meta.title`; series and authors use `entity.name`.
- Subtitle — book uses `meta.authorName`; series and authors use book count.

**Failure mode:** Wrong entity ID for cover URL produces 404 cover requests (Pholia hides broken covers via `onerror`). Wrong title field produces "Unknown" tiles even though the data is in the response. See app.js `showHome` for the per-type branching.

### `GET /api/libraries/:id/items?limit=200`

The Library tab's flat list.

**Response:**
```json
{ "results": [ <library item>, ... ], "total": N }
```

Each library item is the full ABS shape: `{ id, media: { metadata, audioFiles, chapters, duration }, mediaProgress }`.

**Used by:** `Library` tab (showLibrary).

**Failure mode:** Library tab empty. Detail clicks 404 because items aren't cached client-side.

### `GET /api/libraries/:id/series?limit=200&sort=name`

The Series tab.

**Response:**
```json
{ "results": [ { "id", "name", "books": [{ "libraryItemId" | "id", ... }], "numBooks" }, ... ], "total": N }
```

**Used by:** `Series` tab. Pholia reads `data.results` and caches the per-series book list in `_seriesCache` so clicking a series row doesn't refetch.

**Failure mode:** Series tab empty (Pholia reads `data.results`). If `books` array is missing or wrong-shape, series detail view is empty.

### `GET /api/libraries/:id/collections`

The Collections tab.

**Response:**
```json
{ "results": [ { "id", "name", "books": [...], ... } ], ... }
```
or sometimes just an array — Pholia accepts `data.results || data.collections || data || []`.

**Used by:** `Collections` tab.

### `GET /api/collections/:id`

A single collection's detail.

**Response:**
```json
{ "id", "name", "books": [ <library item>, ... ] }
```

**Used by:** Clicking a collection row.

### `GET /api/libraries/:id/authors`

The Authors tab.

**Response:**
```json
{ "authors": [ { "id", "name", "numBooks", "imagePath"? }, ... ] }
```

**Used by:** `Authors` tab.

### `GET /api/authors/:id?include=items`

Author detail — the books by a single author.

**Response:**
```json
{ "id", "name", "libraryItems": [ <library item>, ... ] }
```

**Used by:** Clicking an author tile / row. Pholia reads `data.libraryItems`.

**Failure mode:** Click 404s OR Author detail is empty.

### `GET /api/items/:id`

Full item detail with chapters and audio files.

**Response:**
```json
{
  "id", "libraryId",
  "media": {
    "metadata": { "title", "authorName", "description", ... },
    "audioFiles": [ { "ino", "duration", "bitRate", "codec", "mimeType", "channels", "sampleRate", "metadata": { "size", "filename" }, ... }, ... ],
    "chapters": [ { "id", "start", "end", "title" }, ... ],
    "duration": <seconds>,
    "episodes"?: [ ... ]  // podcasts only
  }
}
```

For podcasts, append `?expanded=1` to get the `episodes` array.

**Used by:** Item detail view, the fullscreen player's file-info flip card, download flow, offline cache size discovery.

**Failure mode:** Detail page broken, can't start playback, can't download.

### `GET /api/items/:id/cover`

Item cover image.

**Response:** Image bytes with appropriate `Content-Type`, `Cache-Control`. CORS-friendly.

**Used by:** Every cover tile. Failure produces broken images, hidden by `<img onerror>`.

### `GET /api/authors/:id/image`

Author thumbnail.

**Response:** Image bytes. Returns 404 cleanly if the author has no image (Pholia handles via `onerror`).

### `GET /api/items/:id/file/:ino` with `Range` support

The actual audio file. Pholia streams it with `Range` headers for both playback and chunked download.

**Required:** `206 Partial Content` responses for Range requests, with:
- Correct `Content-Range: bytes <start>-<end>/<total>` header
- Correct `Content-Length` for the chunk
- Correct `Content-Type` (`audio/mp4`, `audio/mpeg`, etc.)
- `Accept-Ranges: bytes` on the initial response

**Required HEAD:** `HEAD` requests must return `Content-Length` of the full file. Pholia uses HEAD for size discovery during download. `Content-Range` is NOT CORS-safelisted, so don't rely on it from a Range probe.

**Used by:** Playback (the audio element streams via Range), offline download (`Offline._streamFetchToCache` fetches in 10 MB chunks), pre-warm of next track.

**Failure mode:** No Range support → audio won't load or won't seek. Missing `Content-Length` on HEAD → download discovers size via a 1-byte Range probe (works but slower). Wrong `Content-Type` → some iOS-specific playback failures.

### `POST /api/items/:id/play[/:episodeId]`

Start a playback session. Returns a session with audio tracks (the per-file URLs and offsets) and the user's saved position.

**Response:**
```json
{
  "id": "<session id>",
  "currentTime": <seconds>,
  "audioTracks": [
    { "contentUrl": "...", "startOffset": <seconds>, "duration": <seconds>, ... }
  ]
}
```

**Used by:** `Player.startItem` — opens a session, uses `currentTime` as the resume point, uses `audioTracks` for multi-file playback.

**Failure mode:** Player can't start playback.

### `POST /api/session/:id/sync`

Periodic progress sync during playback. Body: `{ currentTime, duration, timeListened }`.

**Response:** 200 OK with an empty body is acceptable. Sometimes 204. Pholia tolerates empty responses (reads body as text, returns null if empty, doesn't try to `JSON.parse('')`).

**Used by:** `Player.startSync` setInterval, every 30 seconds.

**Failure mode:** Console `SyntaxError` on every sync tick if your shim returns 200 with literal `null`-but-not-empty / malformed JSON. Pre-tolerance, this flooded the console every 30 s.

### `GET /api/me/progress/:itemId` (or `/me/progress/:itemId/:episodeId` for podcasts)

Per-item progress record. Returns the saved listening position when there's no active session.

**Response:** `{ currentTime, duration, progress, isFinished, ... }` or 404 if no progress for this item.

**Used by:** `ABS.getProgress` — pre-play resume position when there's no active session.

**Failure mode:** Resume position not restored on cold start. Books always start from 0:00.

### `PATCH /api/me/progress/:itemId`

Update progress without an active session (e.g. for podcasts).

**Body:** `{ currentTime, duration, progress, isFinished }`.

**Response:** 200 OK, empty body acceptable.

## CORS requirements

Pholia is hosted on a different origin (`pholia.pages.dev`) from typical ABS servers. The browser enforces CORS on every request.

**Required headers on EVERY API response:**
- `Access-Control-Allow-Origin: <pholia origin>` (or `*` if your shim is happy with that — real ABS reflects the requesting origin)
- `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type` (minimum)

**Important caveats:**
- Do NOT send `Access-Control-Allow-Credentials: true` combined with `Access-Control-Allow-Headers: *`. That's a CORS spec violation; Safari enforces it strictly and blocks all requests. Either reflect specific headers OR don't claim credentials.
- ABS's OIDC update introduced exactly this combination and broke Safari for weeks. Fixed by switching Pholia to `?token=` auth + `credentials: 'omit'` on every fetch.

**For media-file responses (`/api/items/:id/file/:ino`):**
- `Access-Control-Allow-Origin` must be present even though Pholia's audio element doesn't currently set `crossOrigin`. The Service Worker serves cached chunks back with `Access-Control-Allow-Origin: *` defensively — see `project_pholia_audio_cors` memory.
- `Content-Range` is NOT CORS-safelisted. JS can't read it from a Range response unless your server adds `Access-Control-Expose-Headers: Content-Range`. Real ABS doesn't do this, which is why Pholia uses HEAD `Content-Length` for size discovery instead.

## Auth subtleties

### Tokens in URL paths

Pholia builds cover URLs and audio file URLs with the token embedded as `?token=<jwt>`. These URLs go into `<img src>` and `<audio src>` attributes. Browsers leak src attributes to extensions, referrer headers, etc. — there's a small information disclosure risk if you care about that.

For local-network self-hosted ABS this is generally fine. For internet-exposed ABS, prefer a short JWT TTL.

### Token rotation

If ABS rotates the JWT (e.g. on a re-login), all previously cached URLs become invalid. Pholia handles this by stripping the `token` query param before caching (`Offline.keyFor`) so cache survives rotation. The actual fetch URL still includes the current token.

### Credentials mode

Every Pholia fetch uses `credentials: 'omit'`. Without this, Safari's tracking-prevention may block responses with `Set-Cookie` headers. ABS doesn't need cookies — `?token=` is all the auth state we need — so omitting credentials is safe and avoids the Safari issue.

## Quick failure-mode lookup

| Symptom | Suspect endpoint(s) |
|---|---|
| "Recent X" tile shows "Unknown" but cover loads | `/personalized` — entity shape mismatch for `series`/`authors` type (name lives in `entity.name`, not `meta.title`) |
| 404 cover URLs in console | `/personalized` — wrong entity ID for the section type |
| Series tab empty | `/libraries/:id/series` returning wrong shape (Pholia reads `data.results`) |
| Author click 404s | `/authors/:id?include=items` missing or wrong shape (`data.libraryItems`) |
| Detail page broken | `/items/:id` |
| Resume position not restored | `/me/progress/:itemId` |
| Console flooded with sync errors | `/session/:id/sync` returning malformed JSON instead of empty body |
| Audio won't seek | `/items/:id/file/:ino` not honoring Range / missing `Accept-Ranges` |
| Login works but no content | `/libraries` |
| All requests blocked in Safari only | CORS spec violation — `ACAC: true` + `ACAH: *` is the most common one |
| "Build version is fresh but behavior is old" | Cloudflare Pages cache, see `docs/ios-pwa-gotchas.md` → "fetch() inside SW respects HTTP cache" |

## Related

- `project_pholia_abs_endpoints` memory — terse internal reference for this same content.
- `project_pholia_audio_cors` memory — the defensive ACAO headers in the SW and shim.
- `CLAUDE.md` → "CORS saga" — the historical context for `?token=` auth.
- `docs/ios-pwa-gotchas.md` → "Service Worker" section — selective interception and how it interacts with these endpoints.
