# Project: Cadence

Static HTML/CSS/JS web app — an Audiobookshelf client with future Navidrome/Subsonic API support planned.

- Deployed to **Cloudflare Pages** (project: `cadence`, URL: `cadence-6re.pages.dev`)
- GitHub repo: `jowtron/cadence` (private)
- Go proxy (`main.go`) kept as fallback but not currently used

## Architecture

- `index.html` — Main shell with login, app views, player
- `style.css` — Dark theme, CSS variables, glassmorphic player
- `api.js` — ABS API client (token auth via query param, not Authorization header)
- `player.js` — Audio player with chapter tracking, sleep timer, media session
- `app.js` — Tab navigation, views (home, library, series, collections, authors; podcasts: home, latest, library)
- `sw.js` — Service worker for offline app shell caching (network-first strategy)
- `manifest.json` — PWA manifest
- `_headers` — Cloudflare Pages cache control
- `.github/workflows/deploy.yml` — CI deploy to Cloudflare Pages

## CORS / Auth — Critical Knowledge

This is the single most important section. These learnings were hard-won through extensive debugging.

### The CORS saga

1. **ABS CORS setup:** `ALLOW_CORS=1` env var on the Docker container on NAS host. This was the initial fix to get cross-origin requests working from Cadence to ABS.

2. **ABS OIDC update broke CORS:** An ABS update added OIDC (OpenID Connect) authentication support. This added `access-control-allow-credentials: true` to ALL responses. Combined with `access-control-allow-headers: *`, this violates the CORS spec — wildcards are invalid when credentials are indicated. Safari enforces this strictly and blocks all API requests. Chrome may be more lenient.

3. **Fix — use `?token=` query parameter auth** instead of the Authorization header. ABS natively supports `?token=<jwt>` on all API endpoints (already used for cover images and audio streams). This avoids custom headers entirely. GET requests need no CORS preflight at all. POST requests only need `Content-Type` in allowed headers. This is faster too (one round trip instead of two for GETs).

4. **All fetch calls must use `credentials: 'omit'`** to prevent Safari's cross-site tracking prevention from blocking requests. ABS sets `Set-Cookie` headers on responses, and Safari will block the entire cross-origin request if it thinks cookies are involved.

5. **ABS caches CORS origin incorrectly:** ABS's CORS implementation appears to cache/reflect only one origin at a time. If the Go proxy (`localhost:8090`) or ABS's own web UI makes a request, ABS may start reflecting that origin instead of `cadence-6re.pages.dev`. Fix: restart the ABS Docker container (`docker restart audiobookshelf`). Avoid using the Go proxy to prevent this.

6. The `access-control-allow-credentials: true` + wildcard headers issue is an ABS bug that may be fixed upstream eventually, but the token query param approach is more robust regardless.

### iOS Safari / Tailscale connectivity

iOS Safari requires visiting a Tailscale `.ts.net` domain directly in the browser before cross-origin `fetch()` calls to that domain will work. This is because Tailscale uses a VPN tunnel that iOS needs to "activate" for DNS resolution and TLS handshake. The connection resets after force-quitting Safari or extended device sleep.

**How Cadence handles this:**
- Login failure shows a tappable link: "Tap here to open your server" which opens the ABS URL directly
- Saved session failure shows "Open server to wake connection" link with a Retry button
- Auto-retry on `visibilitychange` and `online` events (e.g., switching back to the app)

## Service Worker & Caching

- **Network-first strategy** for all same-origin requests — always fetches latest code from server, falls back to cache only when offline
- **Cache-first was a disaster** — the initial stale-while-revalidate approach served old JS files (with the broken Authorization header code) and caused login failures. Never use cache-first for JS/CSS in an actively-developed app.
- **`?purge` URL param** — loading `cadence-6re.pages.dev/?purge` nukes all service worker caches and unregisters SWs. Escape hatch for stuck iOS clients.
- **iOS clings to old service workers** aggressively. Clearing Safari history/data may be needed. The `?purge` param helps but isn't always sufficient.
- **Cache version must be bumped** when making breaking changes to cached files (e.g., `cadence-v1` → `cadence-v2`)

## Persistent Login (PWA)

- Credentials stored in localStorage: `cadence_server`, `cadence_username`, `cadence_token`
- `tryAutoLogin()` attempts to restore the session on page load
- **Only clears token on 401/403** (expired/invalid). Network errors preserve the token and show a retry UI.
- The service worker caches the app shell so the PWA loads instantly even when offline
- Auto-reconnect when the app returns to foreground or the device regains network

## Deployment

- **CI:** GitHub Actions workflow deploys to Cloudflare Pages on push to `main`
- **Secrets needed:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (set via `gh secret set`)
- **Build version:** Git commit hash injected at deploy time via `sed` into `#build-version` element
- **Cache:** HTML 60s, JS/CSS 24hr. HTML was originally 1hr which caused stale-code bugs after deploys.
- **Manual deploy:** `workflow_dispatch` trigger in Actions tab
- **Optimizations applied:** Shallow clone, concurrency control (cancel-in-progress), retry with 30s backoff, paths-ignore for non-app files
- **`_headers` file:** Cloudflare Pages cache control headers

## ABS Server

- Running on NAS host in Docker
- Tailscale URL: `https://audiobookshelf.example.ts.net`
- Container name: `audiobookshelf` (changed from `abs-audiobookshelf-1` after an update), port 13378
- Compose file: `/path/to/docker-compose.yml`
- Docker binary: `/path/to/docker`
- ABS login: `jowtron` (not `admin`, not `joseph`)

## ABS API Notes

- **Series detail endpoint** (`/api/series/{id}`) does NOT return books. Use the series list endpoint (`/api/libraries/{id}/series`) which includes books, and cache them client-side.
- **Podcast episodes:** The library items endpoint returns podcasts without episodes. Use `/api/items/{id}?expanded=1` to get episodes. Personalized home sections for podcasts return entities with `recentEpisode` nested objects.
- **Playback sessions:** `POST /api/items/{id}/play/{episodeId}` for podcast episodes. Session includes `audioTracks` with `contentUrl` and `startOffset` for multi-file items.

## Common Pitfalls

- **Never use Authorization header** for ABS API calls — use `?token=` query param
- **Always use `credentials: 'omit'`** on fetch calls
- **Never use cache-first** in the service worker for JS/CSS files
- Browser cache can serve stale HTML after deploys — keep `max-age` low (currently 60s)
- The latest tab element must be null-checked (may not exist in cached HTML from before podcast support)
- Safari on macOS is the primary test browser and is strictest about CORS
- iOS Safari needs Tailscale domain "warmed up" before cross-origin fetches work
- ABS container name may change after updates — always check with `docker ps`
- ABS CORS origin caching means you should avoid hitting ABS from multiple different origins (e.g., don't use the Go proxy and Cadence simultaneously)
- `input type="url"` in HTML rejects bare hostnames — use `type="text"` for server URL input and auto-prepend `https://` in JS
