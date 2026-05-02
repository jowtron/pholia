# Project: Pholia

Static HTML/CSS/JS web app — an Audiobookshelf client with full offline playback and a sliding-window cache-while-playing feature.

- Deployed to **Cloudflare Pages** (project: `pholia`, URL: `pholia.pages.dev` — older URL `cadence-6re.pages.dev` still resolves)
- GitHub repo: `jowtron/pholia` (private)
- Go proxy (`main.go`) kept as fallback but not currently used
- LocalStorage keys are now all `pholia_*`. A one-time migration block at the top of `api.js` copies any pre-existing `cadence_*` values across (the app was originally called Cadence). Pholia-account session bearer is `pholia_session`; the ABS JWT is `pholia_token`.

## Architecture

- `index.html` — Main shell with login, app views, player
- `style.css` — Dark theme, CSS variables, glassmorphic player
- `api.js` — ABS API client (token auth via query param, not Authorization header)
- `player.js` — Audio player with chapter tracking, sleep timer, media session, auto-cache loop
- `app.js` — Tab navigation, views, the `Offline` cache module, settings, SW update flow
- `sw.js` — Service worker: app-shell cache + chunked offline audio cache with Range support
- `manifest.json` — PWA manifest
- `_headers` — Cloudflare Pages cache control (per-file, NOT wildcard — see "Headers" below)
- `.github/workflows/deploy.yml` — CI deploy to Cloudflare Pages

## CORS / Auth — Critical Knowledge

This is the single most important section. These learnings were hard-won through extensive debugging.

### The CORS saga

1. **ABS CORS setup:** `ALLOW_CORS=1` env var on the Docker container on NAS host.

2. **ABS OIDC update broke CORS:** An ABS update added OIDC support, which adds `access-control-allow-credentials: true` to all responses. Combined with `access-control-allow-headers: *`, this violates the CORS spec (wildcards are invalid when credentials are indicated). Safari enforces strictly and blocks all requests.

3. **Fix — use `?token=` query parameter auth** instead of the Authorization header. ABS supports `?token=<jwt>` on all API endpoints. GET requests need no CORS preflight; POST only needs `Content-Type` allowed. Faster too.

4. **All fetch calls must use `credentials: 'omit'`** to prevent Safari's tracking prevention from blocking responses with `Set-Cookie`.

5. **ABS caches CORS origin incorrectly:** ABS reflects only one origin at a time. If a different client (Go proxy, ABS web UI) makes a request, ABS may start reflecting that origin instead of `pholia.pages.dev`. Fix: restart ABS Docker container. Avoid mixing clients.

6. **`Content-Range` is NOT CORS-safelisted.** ABS doesn't add `Access-Control-Expose-Headers: Content-Range`, so JS can't read it from a Range response. Use HEAD's `Content-Length` for size discovery — that header IS safelisted.

### iOS Safari / Tailscale connectivity

iOS Safari requires visiting a Tailscale `.ts.net` domain directly in the browser before cross-origin `fetch()` calls to that domain will work. Connection resets after force-quit or extended sleep.

**How Pholia handles this:**
- Login failure shows a tappable link to open the ABS URL directly
- Saved-session failure shows "Open server to wake connection" + Retry
- Auto-retry on `visibilitychange` and `online` events

## Service Worker — Critical Architecture

These behaviors are *load-bearing*; understand them before editing `sw.js`.

### Selective interception

The SW intercepts cross-origin requests *only when something is cached for that URL*. For uncached URLs the fetch event handler returns without calling `respondWith`, so the browser handles the request natively as if no SW existed.

Why: iOS WebKit adds measurable latency to *every* SW-intercepted media fetch, even for pure passthrough. Streaming over slow networks (Tailscale) couldn't keep up — buffer underruns and audible glitches. Native passthrough avoids the round-trip entirely. This was a regression introduced by the offline-downloads commit (85caf8b) and fixed in 1bb9705.

The SW maintains an in-memory `cachedKeys` Set, populated lazily from `cache.keys()` and refreshed when the page sends `CACHE_CHANGED` messages after `downloadBook`/`deleteBook`. The fetch handler consults this synchronously.

### Chunked offline audio cache

Audio files are cached in **10 MB chunks** (NOT as whole-file Responses). One `cache.put` of a multi-hundred-MB Response OOMs iOS PWA (~50 MB working budget per tab). Chunked downloading keeps memory peak at ~10 MB regardless of file size.

Per track: N chunk entries plus one meta entry (`totalSize`, `chunkSize`, `numChunks`, `contentType`, `sticky`).

**Meta is written *up front* before the chunk loop**, not at the end. With sliding-window auto-cache the loop sleeps indefinitely waiting for playback to catch up to ahead-of-window chunks, so a trailing meta-write would leave coverage queries returning null for most of a session. As a consequence:
- "Meta exists" no longer implies "fully cached" — `isDownloaded`, `fullyDownloadedIds`, `bookSize`, and `cleanupPhantoms` all walk actual chunk presence (don't trust meta alone).
- `cleanupPhantoms` preserves any entry with at least one cached chunk; only fully-orphaned meta is dropped.

**Cache keys MUST use query params, NOT URL fragments.** The Cache API spec strips fragments before storing or matching, so `url#chunk=0`, `url#chunk=1`, `url#meta` all collapse to the same key — every write overwrites the previous one. Use `url?__chunk=0`, `url?__meta=1` instead. (This bug caused weeks of mysterious "downloads complete instantly", "1 byte cached", "all chapters falsely green" symptoms.)

The SW reassembles chunks on the fly when the audio element makes Range requests. Falls through to network if any required chunk is missing (handles partial caches and post-eviction requests gracefully).

### Cache versions

- `pholia-v4` — app shell
- `pholia-offline-audio-v2` — chunked audio + covers (v1 used the broken fragment keys; v2 is auto-cleaned by activate)
- `pholia-offline-meta-v1` — per-book metadata JSON

`KEEP_CACHES` filters which survive activate cleanup. Bump the audio cache version when changing the chunk format.

## Offline mode — Two flavors

### Explicit Download (sticky)
- "Download for offline" button on book detail
- Fetches every track end-to-end in chunks
- Writes meta with `sticky: true`
- Survives auto-cache eviction
- Shows in Settings → Downloaded

### Cache while playing (sliding window)
- Settings toggle, **default off**
- Active during playback (5 s after `startItem`)
- `saveMeta` runs at the *start* of `_startAutoCache` so the book persists across PWA restarts and shows in Settings → Cached even if the loop never finishes
- Chunk-level filter: only caches chunks whose playback time is between `(playhead - 30 min)` and `(playhead + 1 hr)`
- `shouldCache` filter skips behind-cutoff chunks; `beforeChunk` sleeps for ahead-of-window chunks
- After each chunk caches, evicts chunks of the current track more than 30 min behind playhead — but only on `sticky: false` entries
- Cache footprint stays bounded (~1.5 hr of audio at any time)
- Sticky preservation: meta writes never downgrade a previously-sticky entry

### Chapter cache UI

The green overlay on chapter rows reflects *actual* chunk coverage, not `received/total` ratio. Computing fill from `received/total` was wrong for sliding-window because `received` only sums the in-window chunks (~5% of file), so the fill drew from byte 0 to 5% of the book — making it look like only the start was cached.

`Offline.chunkCoverage(item)` does one `cache.keys()` walk and returns per-track `{ totalSize, chunkSize, numChunks, cached: Set<int> }`. `_chapterCovered` maps each chapter's playback-time range to a byte range, then to chunk indices, and only marks the chapter green when *all* overlapping chunks are present. The fullscreen player chapter list and the detail-page chapter list are both painted by the same code path.

## SW Update Flow

- `_headers` has explicit per-file rules. **Do NOT add wildcard rules** — Cloudflare Pages headers are *additive*, so multiple matching rules concatenate. A wildcard `Cache-Control` plus the `/sw.js` `no-cache` resulted in `max-age=86400, ..., no-cache, ..., max-age=86400` — Safari picked one of the long values and cached `sw.js` for 24 hours, breaking all updates. Fixed in f79d8b3.
- `App._pollForUpdate()` awaits `reg.update()`, then awaits the installing SW's `statechange`, then polls `reg.waiting` for up to 10 s (re-fetching the registration each iteration — iOS PWA can be slow to reflect state).
- **`App._checkBuildVersion()`** runs in parallel: fetches `/index.html` with cache-bust, parses the deployed git hash from `#build-version`, and shows the update banner on mismatch. This is the load-bearing path on iOS PWA — `reg.update()` doesn't always re-fetch `sw.js` byte-for-byte even with no-cache headers, so the SW poll silently misses updates and only the version probe catches them. Without it, the only reliable update triggers are the manual "Check for updates" button and force-quitting the PWA.
- Polled from: initial setup, `visibilitychange`, every `switchTab`/`pushNav` (debounced to 10 s).
- Banner has 12 s reload failsafe; manual "Check for updates" button has a `window.location.reload()` fallback for truly stuck installs. The banner click handler also falls through to `window.location.reload()` when there's no `reg.waiting` (covers the version-probe path where SW hasn't picked up the new sw.js yet).

## Persistent Login (PWA)

- Credentials in localStorage: `pholia_server`, `pholia_username`, `pholia_token` (one-time migration from `cadence_*` runs at the top of `api.js`)
- `tryAutoLogin()` restores session on page load
- Only clears token on 401/403 — network errors preserve token + show retry UI

## Deployment

- **CI:** GitHub Actions deploys to Cloudflare Pages on push to `main`
- **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- **Build version:** Git short hash injected via `sed` into `#build-version`
- **Cache headers:** explicit per-file in `_headers`. `sw.js` is `no-cache, no-store, must-revalidate`. JS/CSS are 24 h. HTML is 60 s. **Do not add wildcard rules** (see SW Update Flow).
- Manual deploy via `workflow_dispatch`

## ABS Server

- NAS host in Docker
- Tailscale URL: `https://audiobookshelf.example.ts.net`
- Container: `audiobookshelf`, port 13378
- Compose: `/path/to/docker-compose.yml`
- Docker binary: `/path/to/docker`
- ABS login: `jowtron`

## ABS API Notes

- **Series detail** (`/api/series/{id}`) does not return books. Use the series list endpoint (`/api/libraries/{id}/series`) and cache client-side.
- **Podcast episodes:** library items endpoint returns podcasts without episodes. Use `/api/items/{id}?expanded=1`.
- **Playback sessions:** `POST /api/items/{id}/play/{episodeId}` for podcasts. Session has `audioTracks` with `contentUrl` and `startOffset`.
- **HEAD on file endpoints:** ABS responds with correct `Content-Length` (the full file size). Use this for chunked download size discovery.

## Player Quirks Learned

- **Don't add a buffering "recovery" that nudges `currentTime` after a stall** — it forcibly seeks during normal short buffer underruns and causes louder glitches than the brief stall would have. (Removed in 49924c9.)
- **No spinner on the play button.** Real audio players don't show constant buffering UI; users interpret it as "broken." Removed in f2e6c1c.
- **`preload='auto'`** on the Audio element so the browser buffers ahead aggressively. Helps but doesn't fix slow-network glitches by itself.
- **Pre-warm of next track** in multi-file books: when within 30 s of current track end, fetch first 256 KB of next track in background. Smooths the boundary swap.

## Common Pitfalls

- **Never use Authorization header** for ABS API calls — use `?token=`
- **Always use `credentials: 'omit'`** on fetch calls
- **Cache API URL fragments are stripped** — never use `#chunk=N` style cache keys, use query params
- **Cloudflare Pages `_headers` rules are additive** — don't use wildcards if you need a header to override; use explicit per-file rules
- **`Content-Range` is not CORS-safelisted** — use HEAD `Content-Length` for size discovery
- **iOS PWA memory cap (~50 MB)** — never `cache.put` a multi-hundred-MB Response or `arrayBuffer()` a huge cached entry; both crash the tab
- **iOS WebKit adds latency to SW-intercepted media fetches** — only intercept when something is actually cached
- **Never use cache-first** in the SW for JS/CSS files
- **Cache version must be bumped** when changing the on-disk format
- **Safari on macOS is the primary test browser** — strictest about CORS
- **iOS Safari needs Tailscale domain "warmed up"** before cross-origin fetches work
- **ABS container name may change after updates** — always check with `docker ps`
- **`?purge` URL param** wipes all caches and unregisters the SW — escape hatch for stuck installs
- **ABS CORS origin caching** — avoid hitting ABS from multiple different origins simultaneously
- **`input type="url"`** rejects bare hostnames — use `type="text"` and auto-prepend `https://`
- **`reg.update()` is unreliable on iOS PWA** — pair it with a build-version probe (`fetch('/index.html?_v=…')` + parse `#build-version`) for reliable update detection
- **Don't trust "meta exists" as "fully cached"** — sliding-window writes meta upfront with chunks added incrementally; check actual chunk presence in validators
