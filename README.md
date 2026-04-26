# Pholia

A static-HTML/CSS/JS Audiobookshelf client — installable as a PWA, deployed to Cloudflare Pages, no build step.

Live: [cadence-6re.pages.dev](https://cadence-6re.pages.dev)

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
- Buffering spinner overlay on play buttons when audio stalls
- Auto-recovery: if playback stalls for 8s, `currentTime` is nudged to force a fresh HTTP Range request
- Pre-warming: when within 30s of the end of a track in a multi-file book, the next track's first 256KB is fetched in the background so the boundary swap is near-instant

### Offline mode
- "Download for offline" button on each book — caches audio tracks and cover into the browser's Cache Storage
- Service worker intercepts ABS audio requests; cached files are served with proper HTTP `206 Partial Content` slicing for seek support
- "Downloaded" section on the home tab; works even when the ABS server is unreachable
- Token-stripped cache keys so downloads survive auth token rotation
- Per-book remove

### Browsing
- Home, Library, Series, Collections, Authors tabs
- Podcast support: home / latest episodes / library
- Search (debounced) across the current library
- Clickable author names in book detail → navigate to author's other books

### PWA / Install
- Installable on iOS, Android, desktop
- Persistent login (credentials in localStorage; only cleared on 401/403)
- Network-first service worker for app shell with offline fallback
- Auto-update with banner: detects new SW, applies after 5s, 12s reload failsafe if `controllerchange` doesn't fire
- `?purge` URL param wipes all caches and unregisters the SW (escape hatch for stuck installs)

## Architecture

| File | Role |
| --- | --- |
| `index.html` | App shell — login, views, player UI |
| `style.css` | Dark/light theme, glassmorphic player |
| `api.js` | ABS API client (token via `?token=` query param, not Authorization header) |
| `player.js` | Audio playback, chapters, sleep timer, media session, buffering recovery, pre-warming |
| `app.js` | Routing, views, search, settings, `Offline` download manager, SW update flow |
| `sw.js` | Service worker: app-shell cache + offline audio cache with Range support |
| `manifest.json` | PWA manifest |
| `_headers` | Cloudflare Pages cache control (HTML 60s, JS/CSS 24h, `sw.js` no-cache) |

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
