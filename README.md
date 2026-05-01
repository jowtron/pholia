# Pholia

A static-HTML/CSS/JS Audiobookshelf client — installable as a PWA, deployed to Cloudflare Pages, no build step.

Live: [pholia.pages.dev](https://pholia.pages.dev) (older URL `cadence-6re.pages.dev` still resolves)

## Features

### Playback
- Chapter-aware audio player with mini and fullscreen views
- Per-chapter scrubber (mini player) and per-book scrubber (fullscreen)
- Configurable skip duration (10s–60s) and playback speed (0.5x–3x)
- Sleep timer with end-of-chapter mode and 30s volume fade
- Media Session API: lock-screen controls and metadata on iOS/macOS/Android
- Resume from last position; progress synced back to ABS
- Multi-file books: automatic track switching at boundaries

### Reliability on slow / flaky connections
- `preload='auto'` so the browser buffers ahead aggressively
- Pre-warming: when within 30s of the end of a track in a multi-file book, the next track's first 256KB is fetched in the background so the boundary swap is near-instant
- Service worker passes through uncached cross-origin requests natively (no SW round-trip) to avoid iOS WebKit's per-fetch latency on streaming audio

### Offline mode (two flavors)
- **Download for offline (sticky)** — pin a book end-to-end. 10 MB chunked storage so multi-hundred-MB books don't OOM the iOS PWA. Shows in Settings → Cached. Survives auto-cache eviction.
- **Cache while playing (sliding window)** — opt-in toggle in Settings. Caches a 30 min behind / 1 hr ahead window around the playhead during playback. Footprint stays bounded (~1.5 hr of audio at any time); chunks behind the window are auto-evicted unless the book is sticky-downloaded.
- Chapter list shows a green overlay for chapters whose underlying chunks are all cached, in both the book detail page and the fullscreen player
- Token-stripped cache keys so caches survive auth token rotation
- Per-book remove + Clear-all in Settings

### Browsing
- Home, Library, Series, Collections, Authors tabs
- Podcast support: home / latest episodes / library
- Search (debounced) across the current library
- Clickable author names in book detail → navigate to author's other books

### PWA / Install
- Installable on iOS, Android, desktop
- Persistent login (credentials in localStorage; only cleared on 401/403 — network failures preserve the session)
- Network-first service worker for app shell with offline fallback
- Auto-update with banner: detects new SW via `reg.update()` poll, applies after 5s, 12s reload failsafe
- Build-version probe: fetches `index.html` on nav-tap / visibility change and compares the deployed git hash to the running one. Catches updates that iOS Safari's `reg.update()` silently misses.
- `?purge` URL param wipes all caches and unregisters the SW (escape hatch for stuck installs)

## Architecture

| File | Role |
| --- | --- |
| `index.html` | App shell — login, views, player UI |
| `style.css` | Dark/light theme, glassmorphic player |
| `api.js` | ABS API client (token via `?token=` query param, not Authorization header) |
| `player.js` | Audio playback, chapters, sleep timer, media session, sliding-window auto-cache, pre-warming |
| `app.js` | Routing, views, search, settings, `Offline` cache manager, SW update flow |
| `sw.js` | Service worker: app-shell cache + chunked offline audio cache with Range reassembly |
| `manifest.json` | PWA manifest |
| `_headers` | Cloudflare Pages cache control (per-file rules — `sw.js` no-cache, JS/CSS 24h, HTML 60s) |

## CORS / auth

ABS API calls use `?token=<jwt>` as a query parameter rather than the `Authorization` header. This avoids CORS preflight (GETs only need a simple request) and sidesteps an ABS bug where `access-control-allow-credentials: true` combined with wildcard headers makes Safari reject the response. All `fetch` calls use `credentials: 'omit'` to prevent Safari from blocking based on `Set-Cookie`.

ABS server requires `ALLOW_CORS=1` env var.

## Deployment

- GitHub Actions auto-deploys to Cloudflare Pages on push to `main`
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Build version (git short hash) is injected into `#build-version` at deploy time
- Manual deploy via `workflow_dispatch`

## Development

No build step — open `index.html` from a static server. Any of:

```sh
python3 -m http.server 8000
# or
npx serve .
```

Then visit `http://localhost:8000`.

The Go proxy (`main.go`) is kept around as a fallback for environments where CORS can't be configured on ABS, but is not used in production.

## Caveats / known issues

- iOS Safari needs the Tailscale `.ts.net` domain "warmed up" by visiting it directly in the browser before cross-origin `fetch()` calls work; the app shows a tappable link on connection failure
- Old service workers can stick around aggressively on iOS — use `?purge` if needed
- ABS only reflects one CORS origin at a time; avoid using the Go proxy and the deployed app simultaneously against the same server
