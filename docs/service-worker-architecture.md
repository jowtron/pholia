# Service Worker architecture

Pholia's `sw.js` is more complex than a typical PWA service worker because audio playback on iOS has tight constraints that ruled out the obvious designs. This document walks through what the SW does, why each piece looks the way it does, and which behaviors are load-bearing vs. cosmetic.

## What the SW does (at a glance)

1. **Precaches the app shell** — `index.html`, `style.css`, the JS files, icons. Served network-first online, cache fallback offline.
2. **Caches audio in chunks** — downloads-for-offline + sliding-window-cache-while-playing both write to `OFFLINE_AUDIO_CACHE` in 10 MB chunks.
3. **Reassembles chunks on Range requests** — when the audio element makes a Range request for a fully- or partially-cached file, the SW stitches the requested byte range from the chunked cache and serves it back as `206 Partial Content`. Falls through to network if any required chunk is missing.
4. **Selectively intercepts** — only handles audio requests for URLs that are actually fully cached. Uncached URLs pass through to network natively without the SW's `respondWith` involvement.
5. **Caches cover/author images** — separate cache with LRU eviction.
6. **Activates app updates** — handles `SKIP_WAITING` messages from the page so updates apply cleanly.

## Caches

Five named caches:

| Name | Holds | Eviction |
|---|---|---|
| `pholia-v5` | App shell (HTML, JS, CSS, icons) | Versioned — bump name to invalidate |
| `pholia-offline-audio-v2` | Chunked audio + per-book meta + covers for downloaded books | Sliding-window cache-while-playing evicts behind-window chunks; explicit deletes via Settings |
| `pholia-offline-meta-v1` | Per-book item metadata (full ABS shape) | Cleared with the book |
| `pholia-covers-v1` | Cross-origin cover images (cache-first) | LRU to max 500 entries |
| (legacy: `pholia-v4`, audio v1) | — | Auto-purged on SW activate |

The `KEEP_CACHES` Set in `sw.js` controls which survive activation cleanup. Bump a cache version when changing its on-disk format.

## The chunked audio design

Single audio files in Pholia regularly run 200-600 MB. The naive design — `cache.put(url, response)` for the whole file — OOMs iOS PWA's ~50 MB working memory budget. So audio is sliced into 10 MB chunks before caching.

Per track, the cache holds:
- N chunk entries: `<url>?__chunk=0`, `<url>?__chunk=1`, ..., each 10 MB except the last.
- 1 meta entry: `<url>?__meta=1` with JSON `{ totalSize, chunkSize, numChunks, contentType, sticky }`.
- 1 complete sentinel: `<url>?__complete=1` (empty body, present iff all chunks are present and the right size).

### Why query parameters, not URL fragments

Early implementation used `<url>#chunk=0`, `<url>#chunk=1`. The Cache API strips fragments before storing OR matching — every chunk write overwrites the previous one, every read returns whichever chunk was written last. This caused weeks of mysterious "1 byte cached", "all chapters falsely green", "download completes instantly" symptoms before being diagnosed.

**Always use query params for chunk keys.** Bumped to v2 cache name when fixing.

### Why meta is written upfront, not at the end

The sliding-window auto-cache loop sleeps indefinitely waiting for playback to catch up to ahead-of-window chunks. If meta were written only after the loop completed, books that are partially cached (sliding-window in progress) would have no meta at all — any coverage query (chapter cache fill, downloaded list, etc.) would return null for most of a listening session.

So meta is written **before** the chunk loop starts. Consequence: meta existing does NOT imply all chunks are cached. Validators must walk actual chunk presence:

- `isDownloaded(item)`: checks every chunk's `cache.match`, not just meta.
- `fullyDownloadedIds()`: same.
- `bookSize(item)`: walks present chunks and sums sizes.
- `cleanupPhantoms()`: only drops meta if literally no chunks exist for the item.

### The `__complete` sentinel

Pholia's SW only intercepts audio URLs that are **fully** cached. Partial caches (sliding-window in progress, or after window eviction) pass through to network natively.

Why: iOS WebKit adds measurable latency to every SW-intercepted media fetch, even for pure passthrough. Streaming a partially-cached file with the SW in the loop introduced buffer underruns on slow networks. Native passthrough avoids the latency penalty.

The `__complete` sentinel is the signal — present only when every chunk is cached at the expected size. The SW's `cachedKeys` Set tracks which URLs have this sentinel; the fetch handler consults the Set synchronously. URLs not in the Set return without `respondWith`, leaving the browser to fetch natively.

`_streamFetchToCache` updates the sentinel at the end of each download:
- All chunks present at expected size → `cache.put` the empty `__complete` Response.
- Any chunk missing → `cache.delete` the sentinel.

When the sentinel changes (transitions either direction), the page sends `CACHE_CHANGED` to the SW so it refreshes its `cachedKeys` Set.

## The fetch handler

Three paths, in order:

```js
self.addEventListener('fetch', e => {
    // 1. HEAD passes straight through (memory safety, see below)
    if (e.request.method === 'HEAD') return;

    // 2. Same-origin (app shell): network-first, cache fallback
    if (url.origin === self.location.origin) {
        // ... cache-busting key stripping, network-first ...
        return;
    }

    // 3. Cross-origin: cover images cache-first, audio served from chunked
    //    cache via serveCached/serveChunked, everything else passthrough
});
```

### Why HEAD passes through

`_streamFetchToCache` issues HEAD requests to discover the full file size before downloading. For URLs that are already cached, the SW would otherwise intercept the HEAD and run `serveChunked`'s no-Range branch — which builds a `ReadableStream` that pulls every cached chunk's `arrayBuffer()` into memory and enqueues them.

The HEAD caller never drains the body (HEAD wants headers only). The stream queue holds every chunk in memory — for Flybot's 525 MB book, that's the whole file in JS heap. iOS OOMs the SW, kills the worker mid-handler ("Service Worker context closed"), and on iOS often takes the whole page down with it.

**Fix:** pass HEAD straight through to network at the top of the fetch handler. HEAD goes to the origin for headers only, no body, no memory pressure. See commit `8b74951`.

### `serveChunked` — Range stitching

The audio element makes Range requests like `bytes=12345678-23456789`. `serveChunked` computes which chunk indices overlap that range, fetches each from the cache, slices the relevant bytes, concatenates, and returns as a single `206 Partial Content`.

There's a hard cap on the response size:

```js
const MAX_RANGE_SLICE = 4 * 1024 * 1024;
// after parsing/clamping the Range:
if (end - start + 1 > MAX_RANGE_SLICE) end = start + MAX_RANGE_SLICE - 1;
```

Why: iOS sends open-ended `bytes=N-` Ranges after seeks. Without the cap, the SW would stitch every chunk from N to end-of-file into one Blob — easily 500+ MB → instant OOM. With the cap, iOS sees a 206 covering only the first 4 MB, requests more after consuming that, and the worker peak memory stays bounded.

The 4 MB number is conservative — much smaller than the chunk size, so a Range never needs more than ~2 chunks loaded simultaneously.

### `serveCached` — legacy whole-file entries

Older versions of Pholia cached audio as single whole-file entries (no chunking). `serveCached` handles those when present. It also caps its 206 slices to `MAX_RANGE_SLICE` for the same reason.

The activate handler purges any whole-file entries larger than 50 MB on startup — these were the source of the original OOM bugs and shouldn't exist after the cache v2 migration, but the cleanup is defense-in-depth.

## Selective interception via `cachedKeys`

The SW maintains an in-memory `Set<string>` of URLs it has the right to serve. Populated lazily on first fetch handler invocation by walking `cache.keys()` on the `OFFLINE_AUDIO_CACHE` and filtering for the `__complete` sentinel.

```js
let cachedKeys = null;
async function loadCachedKeys() {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    const set = new Set();
    try {
        const keys = await cache.keys();
        for (const req of keys) set.add(req.url);
    } catch {}
    cachedKeys = set;
}
```

On a cross-origin audio fetch, the handler:
1. Checks the request URL against `cachedKeys`. Not present → return without `respondWith` (browser fetches natively, no SW latency).
2. Present → call `serveChunked` (or `serveCached` for legacy) to assemble the response from cache.

`cachedKeys` is refreshed when the page sends `{ type: 'CACHE_CHANGED' }` after `downloadBook` / `deleteBook` writes. This is the only signal from page to SW about cache state.

**Critical:** the synchronous check in the fetch handler must consult the in-memory Set, not call `cache.match` directly. Every `await cache.match` in the fetch handler adds the iOS WebKit interception latency, defeating the whole point.

## Update flow

The `sw.js` file is served with `Cache-Control: no-cache, no-store, must-revalidate` (see `_headers`). The browser fetches it fresh on `reg.update()`. If it differs byte-for-byte, a new SW installs in `waiting` state.

But iOS PWA `reg.update()` is unreliable — sometimes returns "no update available" even when `sw.js` actually changed. So Pholia ALSO runs a build-version probe: fetch `/index.html?_v=<timestamp>`, parse the `#build-version` div, compare to the version in the loaded page. If they differ, show the update banner regardless of SW state.

The banner click sends `{ type: 'SKIP_WAITING' }` to the waiting SW. The SW handles it:
```js
if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
```

Activation fires `controllerchange` on the page, which triggers a reload. There's a 12 s failsafe that reloads anyway if `controllerchange` never arrives.

See `_headers` setup: do NOT add wildcard rules — Cloudflare Pages headers are additive, and a wildcard `Cache-Control` combined with the explicit `/sw.js` rule produces a concatenated header Safari can't parse correctly. Always per-file rules.

### Cache-bust query param on JS/CSS

Even with the SW updating, browsers may serve stale `app.js` from HTTP cache (24h `max-age`). The fetch inside the SW respects HTTP cache by default.

Pholia mitigates by injecting `?v=<short-git-hash>` into every script and link tag in `index.html` via `sed` in the deploy workflow. Each deploy mints fresh URLs that bypass HTTP cache. The SW strips the `?v=` param before `cache.put` / `cache.match` so we don't leak an entry per deploy, and the `APP_SHELL` preload list (canonical URLs without `?v=`) still satisfies offline fallback. See `project_pholia_cache_busting` memory and `docs/ios-pwa-gotchas.md`.

## Cross-origin covers

`COVERS_CACHE` (`pholia-covers-v1`) holds cover/author images. Cache-first, populated lazily on first fetch. Independent from audio cache so eviction here doesn't churn downloaded books.

LRU eviction at 500 entries — `evictCovers(cache)` keeps the cache from growing unbounded across many libraries.

The iOS WebKit SW-fetch latency penalty matters less for one-shot image GETs than it does for the many-Range audio streaming, so we accept the small overhead in exchange for offline cover support.

## Load-bearing summary

If you take nothing else from this doc:

| Behavior | Don't |
|---|---|
| HEAD requests pass through (`if (request.method === 'HEAD') return`) | Remove the early-return — HEAD on a cached URL OOMs the worker |
| `MAX_RANGE_SLICE = 4 MB` cap | Increase it or remove — open-ended Ranges will OOM the tab |
| Chunked storage with query-param keys | Switch to URL fragments — Cache API strips them, every write overwrites |
| Meta written upfront, not at end | Defer meta to after the loop — partial caches become invisible |
| Selective interception via `cachedKeys` | Always-intercept audio — iOS playback gets buffer underruns |
| `__complete` sentinel gates interception | Intercept partials — same problem |
| `cache.put` cache-key strips `?v=` for app shell | Use raw request URL — cache leaks an entry per deploy |
| Wildcard `_headers` rules avoided | Add `/*` rule — concatenates with per-file rules, Safari mis-parses |

Also see `project_pholia_sw_memory` memory for the same content in shorter form, and the inline comments in `sw.js` (which are extensive and the source of truth for any specific line).

## Related

- `docs/ios-pwa-gotchas.md` → Memory + Service Worker sections.
- `docs/battery-usage-minimisation.md` → SWR cooldown, chunkCoverage memoization (page-side, not SW).
- `docs/abs-api-contract.md` → what the SW is caching from.
- `CLAUDE.md` → Service Worker — Critical Architecture (the original notes, slightly more terse than this doc).
