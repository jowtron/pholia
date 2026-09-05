# Project: Pholia

Static HTML/CSS/JS web app — an Audiobookshelf client with full offline playback and a sliding-window cache-while-playing feature.

- Deployed to **Cloudflare Pages** (project: `pholia` on the Josephderrickrepairs account, URL: `pholia.jderrick.app`, alias `pholia-3fd.pages.dev`. `pholia.pages.dev` is a stale project on another account serving build 92ba0fc — not updated by CI)
- GitHub repo: hosted on GitHub
- Go proxy (`main.go`) was a local CORS-bypass fallback (pre `?token=` auth); **archived out of this repo** to `~/Claude_Code/isub/go-proxy/` (2026-06-22), no longer deployed
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

1. **ABS CORS setup:** `ALLOW_CORS=1` env var on the ABS Docker container.

2. **ABS OIDC update broke CORS:** An ABS update added OIDC support, which adds `access-control-allow-credentials: true` to all responses. Combined with `access-control-allow-headers: *`, this violates the CORS spec (wildcards are invalid when credentials are indicated). Safari enforces strictly and blocks all requests.

3. **Fix — use `?token=` query parameter auth** instead of the Authorization header. ABS supports `?token=<jwt>` on all API endpoints. GET requests need no CORS preflight; POST only needs `Content-Type` allowed. Faster too.

4. **All fetch calls must use `credentials: 'omit'`** to prevent Safari's tracking prevention from blocking responses with `Set-Cookie`.

5. **ABS caches CORS origin incorrectly:** ABS reflects only one origin at a time. If a different client (Go proxy, ABS web UI) makes a request, ABS may start reflecting that origin instead of `pholia.pages.dev`. Fix: restart ABS Docker container. Avoid mixing clients.

6. **`Content-Range` is NOT CORS-safelisted.** ABS doesn't add `Access-Control-Expose-Headers: Content-Range`, so JS can't read it from a Range response. Use HEAD's `Content-Length` for size discovery — that header IS safelisted.

### Connection-failure recovery

When a fetch fails for any reason (server down, network blip, sleeping
laptop hosting ABS), Pholia surfaces a tappable link to the ABS URL so
the user can poke the server in their browser, plus auto-retries on
`visibilitychange` and `online` events.

- Login failure shows a tappable link to open the ABS URL directly
- Saved-session failure shows "Open server to test connection" + Retry
- Auto-retry on `visibilitychange` and `online` events

## Service Worker — Critical Architecture

These behaviors are *load-bearing*; understand them before editing `sw.js`.

### Selective interception — all-worker or all-native per file

**iOS's media loader cancels a resource whose CORS status changes between Range responses.** A response the SW synthesizes (it carries `Access-Control-Allow-Origin: *`) and a native no-cors media request have different statuses, so for one media load the SW must answer *every* request for that file or *none* of them. Mixing was the real reason "partial cache breaks iOS" (2026-09-03: cached header, then the file tail re-requested natively every 170 ms until the loader gave up).

So the page announces each media load: `App.pinMediaMode(url)` posts `MEDIA_LOAD` over a MessageChannel before `audio.src` is assigned (`Player.loadTime`, `onTrackEnded`), and the SW pins a mode per file (`modeFor`): `sw` when the file is fully cached, or partially cached with the Settings toggle "Play from partial cache" on (default on); otherwise `native`. In `sw` mode `serveChunked` streams the contiguous cached run and bridges everything else from the server inside the same 206 via `corsFetch` — a CORS `fetch` carrying **only** `Range` (the media element's own headers include iOS's non-safelisted `X-Playback-Session-Id`, which forces a preflight). The bridge starts when the response starts, so the server's cold first byte overlaps cached playback. In `native` mode the fetch handler returns without `respondWith`. Pins and both flags persist in the `pholia-sw-config-v1` cache because iOS restarts the worker constantly; a fresh worker awaits its key map for audio requests rather than passing the first ones through. Un-pinned files fall back to the old rule (fully cached → SW, else native).

The original reason for not intercepting everything still stands: iOS WebKit adds latency to every SW-intercepted media fetch, so uncached files stay native (regression 85caf8b, fixed 1bb9705).

The SW maintains an in-memory `cachedKeys` Set / `cachedMetas` / `cachedChunks`, populated from `cache.keys()` at activate, on `MEDIA_LOAD`, and when the page sends `CACHE_CHANGED` after chunk writes/deletes.

### Chunked offline audio cache

Audio files are cached in **10 MB chunks** (NOT as whole-file Responses). One `cache.put` of a multi-hundred-MB Response OOMs iOS PWA (~50 MB working budget per tab). Chunked downloading keeps memory peak at ~10 MB regardless of file size.

Per track: N chunk entries plus one meta entry (`totalSize`, `chunkSize`, `numChunks`, `contentType`, `sticky`).

**Meta is written *up front* before the chunk loop**, not at the end. With sliding-window auto-cache the loop sleeps indefinitely waiting for playback to catch up to ahead-of-window chunks, so a trailing meta-write would leave coverage queries returning null for most of a session. As a consequence:
- "Meta exists" no longer implies "fully cached" — `isDownloaded`, `fullyDownloadedIds`, `bookSize`, and `cleanupPhantoms` all walk actual chunk presence (don't trust meta alone).
- `cleanupPhantoms` preserves any entry with at least one cached chunk; only fully-orphaned meta is dropped.

**Cache keys MUST use query params, NOT URL fragments.** The Cache API spec strips fragments before storing or matching, so `url#chunk=0`, `url#chunk=1`, `url#meta` all collapse to the same key — every write overwrites the previous one. Use `url?__chunk=0`, `url?__meta=1` instead. (This bug caused weeks of mysterious "downloads complete instantly", "1 byte cached", "all chapters falsely green" symptoms.)

The SW reassembles chunks on the fly when the audio element makes Range requests; for a worker-pinned file, bytes it doesn't have are bridged from the server in the same response (see above) — never by letting the request go native.

### Cache versions

- `pholia-v5` — app shell
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
- Banner has 12 s reload failsafe. The banner click handler falls through to `window.location.reload()` when there's no `reg.waiting` (covers the version-probe path where SW hasn't picked up the new sw.js yet). The manual "Check for updates" button runs both probes and shows "Up to date" when neither finds anything — it does NOT auto-reload (a previous brute-force reload here caused user confusion).

## Persistent Login (PWA)

- Credentials in localStorage: `pholia_server`, `pholia_username`, `pholia_token` (one-time migration from `cadence_*` runs at the top of `api.js`)
- `tryAutoLogin()` restores session on page load
- Only clears token on 401/403 — network errors preserve token + show retry UI
- **An iOS home-screen app is a separate storage partition.** Nothing saved while running in Safari (localStorage, cookies, Cache Storage) exists in the installed app; only passkeys (iCloud Keychain) and the manifest's `start_url` cross over. Two things lean on that (2026-09-05):
  - `functions/manifest.json.js` serves the manifest with `start_url=/?server=<url>&u=<username>` taken from the `<link rel="manifest">` query (`?s=&u=`) or the `pholia_install` cookie. **The link is written by an inline `<head>` script** (from the `#connect=` fragment or the saved `pholia_server`) with `crossorigin="use-credentials"`: iOS resolves the manifest from the link as parsed and sends no cookies without that attribute, so the first version (a static link rewritten later by `ABS.setInstallHint`) installed an app with an empty login form. `setInstallHint` still updates the href/cookie for a server switch later in the same page load. `App._consumeInstallHint()` (first thing in `tryAutoLogin`) adopts it as the login-form prefill when the partition has no `pholia_server`, then strips it from the URL. `sw.js` strips `server`/`u` from the shell cache key so an offline launch still hits the precached `./`. The manifest has `"id": "/"` so the changing manifest URL is still one app. **The token is never put in `start_url`** — it would live in a launch URL forever.
  - **Token-only vault entries** (`abs_servers.encrypted_token`, schema 0003; `POST /api/servers` takes `password` and/or `token`, `GET /api/servers/:id` returns both, null when absent). The ABS_shim hand-off (`_consumePholiaHandoff`, `#connect=` fragment from the shim's "Open Pholia") signs in with a token and no password ever passes through Pholia, so after it lands `_maybeOfferSaveToAccount({token, handoff:true})` rewords the save-to-account modal ("Sign in with Face ID next time?") and the vault entry holds the token. `loginFromAccount` uses the password when there is one, else `ABS.authorize()` (`POST /api/authorize?token=`) and re-saves the fresh token. Because the local copy and the vault copy would otherwise expire on the same day, `_maybeRotateToken` runs on every ordinary auto-login once the JWT `exp` is within 20 days and pushes the new token into the vault — but only into an entry that already exists (a declined "save to account" stays declined). A user who doesn't open the app for a whole token lifetime (30 days on the shim) is asked for their password, with server + username prefilled. Settings → "Save current server to account" still asks for a password on purpose: real ABS ≥2.26 access tokens are short-lived, so a token entry is only ever created from the shim hand-off.

## Deployment

- **CI:** GitHub Actions deploys to Cloudflare Pages on push to `main`
- **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- **Build version:** Git short hash injected via `sed` into `#build-version`
- **Cache headers:** explicit per-file in `_headers`. `sw.js` is `no-cache, no-store, must-revalidate`. JS/CSS are 24 h. HTML is 60 s. **Do not add wildcard rules** (see SW Update Flow).
- Manual deploy via `workflow_dispatch`

## ABS Server

ABS runs in Docker. Specifics of the ABS host (container name, ports,
paths) are intentionally left out of this repo; keep them in private notes.

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
- **Books without chapters must still scrub.** The mini and FS scrubbers represent *chapter* progress, not book progress. When `chapters` is empty (some ABS items have none), `getChapterProgress` and `seekToChapterPercent` fall back to whole-book progress/seeking — don't reintroduce a `if (!ch) return` early-out without a fallback or the scrubber goes dead.

## Common Pitfalls

- **Never use Authorization header** for ABS API calls — use `?token=`
- **Always use `credentials: 'omit'`** on fetch calls
- **Cache API URL fragments are stripped** — never use `#chunk=N` style cache keys, use query params
- **Cloudflare Pages `_headers` rules are additive** — don't use wildcards if you need a header to override; use explicit per-file rules
- **`Content-Range` is not CORS-safelisted** — use HEAD `Content-Length` for size discovery
- **iOS PWA memory cap (~50 MB)** — never `cache.put` a multi-hundred-MB Response or `arrayBuffer()` a huge cached entry; both crash the tab
- **iOS WebKit adds latency to SW-intercepted media fetches** — only intercept when something is actually cached
- **A media load must be all-SW or all-native** — iOS cancels when a response's CORS status differs from earlier ones; pin the mode per file at `MEDIA_LOAD`, bridge gaps with a Range-only CORS fetch, never mix
- **Never use cache-first** in the SW for JS/CSS files
- **Cache version must be bumped** when changing the on-disk format
- **Safari on macOS is the primary test browser** — strictest about CORS
- **ABS container name may change after updates** — always check with `docker ps`
- **`?purge` URL param** wipes all caches and unregisters the SW — escape hatch for stuck installs
- **ABS CORS origin caching** — avoid hitting ABS from multiple different origins simultaneously
- **`input type="url"`** rejects bare hostnames — use `type="text"` and auto-prepend `https://`
- **`reg.update()` is unreliable on iOS PWA** — pair it with a build-version probe (`fetch('/index.html?_v=…')` + parse `#build-version`) for reliable update detection
- **Don't trust "meta exists" as "fully cached"** — sliding-window writes meta upfront with chunks added incrementally; check actual chunk presence in validators

## "Add audiobook" (ABS_shim only)

When the server is an ABS_shim with a Real-Debrid token (`GET /api/admin/abb/settings` → `rdTokenSet:true`) and a `pcloud_oauth` folder, `App.checkAbbSupport()` unhides `#abb-btn` — the ABB-logo icon (`icons/abb.svg`, traced from Joseph's PNG; 17 paths) in the header beside search. It opens the Add screen (`App.showAdd()`, internal tab state `'add'` with no bottom tab; back arrow / tapping the icon again returns to the previous tab). The grab flow (`abbGrab` → `abbFetchToPcloud` → `abbExtractZip`) drives shim routes `/api/admin/abb/*` (`search`, `details`, `resolve`, `torrents`), `/api/admin/storage/folder/:id/fetch-url/*`, `extract/*`, and finishes with `POST /api/admin/libraries/:id/scan` (the shim only auto-registers single m4b files; mp3 releases need the scan). A release with more than one audio/archive file opens a directory-grouped picker (`abbPickFiles`) and one RD torrent is added per chosen file; `abbPlanDest` keeps the torrent's sub-folders on pCloud (one book per folder). The search box also accepts a pasted `magnet:` link. An "On Real-Debrid" `<details>` under the results lists the account's torrents grouped by hash (video-looking names hidden by default) with Choose files… / Watch / Finish / Delete — the grab loop runs in the tab, so this is how a grab interrupted by closing the app is resumed (`abbTrackTorrents`). Resumed/in-flight rows render in the "In progress" block above the results.

**Delete from pCloud** (`App.isShim` only): long-press a book card (`_wireLongPress`, 550 ms; right-click on desktop) or tap "Delete from pCloud…" on the book page → `confirmDeleteItem` (shows format/length) → `DELETE /api/admin/items/:id?deleteFiles=1`. Irreversible: removes the audio files from pCloud and the library entry.

Renaming any of those routes on the shim hides/breaks this screen silently — change both repos together. Stock ABS 404s the first probe, so the icon never shows there.

## AudioBookBay browse-by-category (2026-09-02)

The Add screen has a browse row (category / language / format selects + Browse) under the search bar, fed by the shim's catalogue routes `GET /api/admin/abb/catalog/categories` and `GET /api/admin/abb/catalog/browse?cat=&language=&format=&page=`. `abbLoadFacets()` hides the row when the endpoint 404s (older shim) or the catalogue is empty. Search and browse share `_abbRenderResults()` (same Grab flow); browse appends pages via a "Load more" text button. A "⚡" in a result's sub-line means the shim has the magnet cached, so Grab skips AudioBookBay. Search results may carry `liveError` (shim answered from its catalogue because ABB didn't respond) — shown as a hint above the list.
