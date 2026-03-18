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
- `manifest.json` — PWA manifest
- `_headers` — Cloudflare Pages cache control
- `.github/workflows/deploy.yml` — CI deploy to Cloudflare Pages

## CORS / Auth — Critical Knowledge

This is the single most important section. These learnings were hard-won.

1. **ABS CORS setup:** `ALLOW_CORS=1` env var on the Docker container on NAS host.

2. **ABS OIDC update broke CORS:** The update added `access-control-allow-credentials: true` to all responses. Combined with `access-control-allow-headers: *`, this violates the CORS spec — wildcards are invalid when credentials are indicated. Safari enforces this strictly and blocks all API requests.

3. **Fix — use `?token=` query parameter auth** instead of the Authorization header. This avoids custom headers entirely. GET requests need no preflight. POST requests only need `Content-Type` allowed.

4. **All fetch calls must use `credentials: 'omit'`** to avoid Safari's cross-site tracking prevention blocking requests that set cookies.

5. The `access-control-allow-credentials: true` + wildcard headers issue is an ABS bug that may be fixed upstream eventually, but the token query param approach is more robust regardless.

## Deployment

- **CI:** GitHub Actions workflow deploys to Cloudflare Pages on push to `main`
- **Secrets needed:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- **Build version:** Git commit hash injected at deploy time via `sed`
- **Cache:** HTML 60s, JS/CSS 24hr
- **Manual deploy:** `workflow_dispatch` trigger in Actions tab

## ABS Server

- Running on NAS host in Docker
- Tailscale URL: `https://audiobookshelf.example.ts.net`
- Container: `abs-audiobookshelf-1`, port 13378
- Compose file: `/path/to/docker-compose.yml`
- Docker binary: `/path/to/docker`

## Common Pitfalls

- **Never use Authorization header** for ABS API calls — use `?token=` query param
- **Always use `credentials: 'omit'`** on fetch calls
- Browser cache can serve stale HTML after deploys — reduced to 60s max-age
- The latest tab element must be null-checked (may not exist in cached HTML)
- Safari on macOS is the primary test browser and is strictest about CORS
