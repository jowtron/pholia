const CACHE_NAME = 'pholia-v5';
const OFFLINE_AUDIO_CACHE = 'pholia-offline-audio-v2';
const OFFLINE_META_CACHE = 'pholia-offline-meta-v1';
const COVERS_CACHE = 'pholia-covers-v1';
// Tiny persisted SW settings (see loadConfig) — must survive activate's cache sweep.
const CONFIG_CACHE = 'pholia-sw-config-v1';
const CONFIG_KEY = 'https://pholia.local/sw-config';
const MAX_COVERS = 500;
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './api.js',
    './account.js',
    './app.js',
    './player.js',
    './manifest.json',
    './favicon.ico',
    './icons/apple-touch-icon.png',
    './icons/favicon-16x16.png',
    './icons/favicon-32x32.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

const KEEP_CACHES = new Set([CACHE_NAME, OFFLINE_AUDIO_CACHE, OFFLINE_META_CACHE, COVERS_CACHE, CONFIG_CACHE]);

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => !KEEP_CACHES.has(k)).map(k => caches.delete(k)));
        // Purge /api/ entries cached before the fetch handler excluded them —
        // they can contain decrypted server credentials and session tokens.
        try {
            const shell = await caches.open(CACHE_NAME);
            for (const req of await shell.keys()) {
                if (new URL(req.url).pathname.startsWith('/api/')) await shell.delete(req);
            }
        } catch (e) { /* best effort */ }
        // Purge legacy whole-file entries larger than 50 MB. They OOM the tab
        // when the SW tries to slice them in serveCached.
        try {
            const audio = await caches.open(OFFLINE_AUDIO_CACHE);
            const audioKeys = await audio.keys();
            for (const req of audioKeys) {
                if (req.url.includes('__chunk=') || req.url.includes('__meta=') || req.url.includes('__complete=')) continue;
                const r = await audio.match(req);
                if (!r) continue;
                const len = parseInt(r.headers.get('content-length') || '0', 10);
                if (len > 50 * 1024 * 1024) await audio.delete(req);
            }
        } catch {}
        // Migrate: ensure the __complete sentinel matches actual chunk
        // presence for every chunked entry. The fetch handler intercepts
        // ONLY entries with this sentinel — partial caches need to fall
        // through to native fetch to avoid iOS WebKit's SW-media-fetch
        // latency penalty. Without this, books fully downloaded before
        // the sentinel was introduced would never be intercepted.
        try {
            const audio = await caches.open(OFFLINE_AUDIO_CACHE);
            const audioKeys = await audio.keys();
            const allUrls = new Set(audioKeys.map(r => r.url));
            for (const req of audioKeys) {
                if (!/[?&]__meta=1$/.test(req.url)) continue;
                const baseKey = req.url.replace(/[?&]__meta=1$/, '');
                const completeUrl = baseKey + (baseKey.includes('?') ? '&' : '?') + '__complete=1';
                let meta;
                try { meta = await (await audio.match(req)).json(); } catch { continue; }
                let allPresent = true;
                for (let i = 0; i < (meta.numChunks || 0); i++) {
                    const chunkUrl = baseKey + (baseKey.includes('?') ? '&' : '?') + '__chunk=' + i;
                    if (!allUrls.has(chunkUrl)) { allPresent = false; break; }
                }
                if (allPresent && !allUrls.has(completeUrl)) {
                    await audio.put(completeUrl, new Response(''));
                } else if (!allPresent && allUrls.has(completeUrl)) {
                    await audio.delete(completeUrl);
                }
            }
        } catch {}
        // Eagerly populate cachedKeys so the fetch handler can decide
        // synchronously whether to intercept cross-origin requests.
        await loadCachedKeys();
        await self.clients.claim();
    })());
});

self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
    if (e.data?.type === 'CACHE_CHANGED') loadCachedKeys();
    if (e.data?.type === 'SW_CONFIG') {
        experimentalPartialCache = !!e.data.experimentalPartialCache;
        swDebugLog = !!e.data.swDebugLog;
        configLoaded = Promise.resolve();
        saveConfig();
        debugLog('config', { experimentalPartialCache, swDebugLog });
    }
});

// Serve partially cached books from the local cache when the requested Range
// starts inside a cached chunk (Settings → "Play from partial cache", default
// ON since 2026-09-03). The earlier version stopped the response at the first
// gap, which iOS can't recover from; serveChunked now bridges the gap with a
// network fetch that is started up front, so the shim's cold first byte
// overlaps the cached playback instead of stalling it.
let experimentalPartialCache = true;
// Separate flag for the debug log so instrumentation can stay on independently.
let swDebugLog = false;
// iOS restarts this worker constantly and plain globals revert to their
// defaults before the page re-sends SW_CONFIG — so both flags are persisted
// in Cache Storage and read back on the first fetch after a restart.
let configLoaded = null;
function loadConfig() {
    if (!configLoaded) {
        configLoaded = (async () => {
            try {
                const c = await caches.open(CONFIG_CACHE);
                const r = await c.match(CONFIG_KEY);
                if (!r) return;
                const j = await r.json();
                if (typeof j.experimentalPartialCache === 'boolean') experimentalPartialCache = j.experimentalPartialCache;
                if (typeof j.swDebugLog === 'boolean') swDebugLog = j.swDebugLog;
            } catch {}
        })();
    }
    return configLoaded;
}
async function saveConfig() {
    try {
        const c = await caches.open(CONFIG_CACHE);
        await c.put(CONFIG_KEY, new Response(JSON.stringify({ experimentalPartialCache, swDebugLog }), { headers: { 'Content-Type': 'application/json' } }));
    } catch {}
}

function debugLog(tag, data) {
    if (!swDebugLog) return;
    try {
        const msg = { type: 'SW_DEBUG', tag, t: Date.now(), data };
        self.clients.matchAll().then(list => list.forEach(c => c.postMessage(msg)));
        console.log('[sw]', tag, data);
    } catch {}
}

// Synchronously available state for fetch-handler decisions. Populated at
// boot and refreshed on CACHE_CHANGED. Stale = miss intercept opportunities
// (safe regression), never wrong content.
//   cachedKeys      — Set<url> of every entry in OFFLINE_AUDIO_CACHE
//   cachedMetas     — Map<baseKey, {chunkSize, numChunks, totalSize}>
//   cachedChunks    — Map<baseKey, Set<chunkIndex>> of which chunks are cached
let cachedKeys = null;
let cachedMetas = null;
let cachedChunks = null;
// One in-flight key walk at a time: a burst of Range requests on a fresh
// worker would otherwise each start their own cache.keys() pass.
let keysLoading = null;
function ensureKeys() {
    if (cachedKeys !== null) return Promise.resolve();
    if (!keysLoading) keysLoading = loadCachedKeys().finally(() => { keysLoading = null; });
    return keysLoading;
}
const AUDIO_PATH_RE = /\/api\/items\/[^/]+\/file\/[^/]+$/;

function baseKeyFromMarker(url, marker) {
    const q = url.indexOf('?' + marker);
    if (q !== -1) return url.substring(0, q);
    const a = url.indexOf('&' + marker);
    if (a !== -1) return url.substring(0, a);
    return null;
}

async function loadCachedKeys() {
    const set = new Set();
    const metas = new Map();
    const chunks = new Map();
    try {
        const cache = await caches.open(OFFLINE_AUDIO_CACHE);
        const keys = await cache.keys();
        const metaReqs = [];
        for (const req of keys) {
            set.add(req.url);
            const url = req.url;
            if (/[?&]__meta=1$/.test(url)) {
                const baseKey = baseKeyFromMarker(url, '__meta=1');
                if (baseKey) metaReqs.push({ req, baseKey });
                continue;
            }
            const chunkBase = baseKeyFromMarker(url, '__chunk=');
            if (chunkBase) {
                const idx = url.indexOf('__chunk=');
                const n = parseInt(url.substring(idx + '__chunk='.length), 10);
                if (!isNaN(n)) {
                    let s = chunks.get(chunkBase);
                    if (!s) { s = new Set(); chunks.set(chunkBase, s); }
                    s.add(n);
                }
            }
        }
        await Promise.all(metaReqs.map(async ({ req, baseKey }) => {
            try {
                const res = await cache.match(req);
                if (!res) return;
                const m = await res.json();
                if (m && m.chunkSize && m.numChunks && m.totalSize) {
                    metas.set(baseKey, {
                        chunkSize: m.chunkSize,
                        numChunks: m.numChunks,
                        totalSize: m.totalSize,
                    });
                }
            } catch {}
        }));
    } catch {}
    cachedKeys = set;
    cachedMetas = metas;
    cachedChunks = chunks;
}

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // HEAD requests want headers only — never a body. The auto-cache size
    // probe (_streamFetchToCache HEAD) hits cached audio URLs; if we let
    // serveChunked answer, its "no Range" branch streams every cached
    // chunk into memory because the HEAD caller never drains the body.
    // That OOMs the SW under iOS PWA's tiny memory budget, kills the
    // worker mid-handler ("Service Worker context closed"), and on iOS
    // takes the whole page down with it. Pass HEAD straight to network.
    if (e.request.method === 'HEAD') return;

    if (url.origin === self.location.origin) {
        // Never intercept account/Pages-Functions API calls: responses carry
        // decrypted server credentials and session tokens, which must not be
        // persisted into Cache Storage (or replayed by the offline fallback).
        if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
        // App shell: network-first, cache fallback when offline.
        // Strip the ?v= cache-bust param so different deploys collapse to one
        // cache entry per logical file. APP_SHELL preloads use canonical URLs
        // (no ?v=) so the offline fallback still finds them after a fresh
        // install. Without this, each deploy would leak a new cache entry per
        // file and the install-time entries would never get refreshed.
        const cacheKey = (() => {
            const u = new URL(e.request.url);
            u.searchParams.delete('v');
            return u.toString();
        })();
        e.respondWith(
            fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
                }
                return res;
            }).catch(() => caches.match(cacheKey))
        );
        return;
    }

    // Cross-origin cover/author images: cache-first, populated lazily on first
    // fetch. Independent from the audio cache so eviction here doesn't churn
    // downloaded books. The iOS-WebKit SW-fetch latency penalty doesn't matter
    // for one-shot image GETs the way it does for many-Range audio streaming.
    if (e.request.method === 'GET' && isCoverUrl(url)) {
        e.respondWith(handleCover(e.request));
        return;
    }

    if (cachedKeys === null || configLoaded === null) {
        // Fresh worker (iOS restarts it constantly): the key map and the
        // persisted flags aren't loaded yet. Other requests pass through;
        // audio waits the few ms for the map so the first play after a
        // restart still comes from cache instead of always going to the
        // network (which is what "cached books still take ages" was).
        const ready = Promise.all([ensureKeys(), loadConfig()]);
        if (!AUDIO_PATH_RE.test(url.pathname)) return;
        e.respondWith(ready.then(() => decideAudio(e.request, url) || fetch(e.request)));
        return;
    }
    const handled = decideAudio(e.request, url);
    if (handled) e.respondWith(handled);
});

// Returns a Response promise when the cache should answer, null for native
// passthrough. Pure function of the loaded key map + flags.
function decideAudio(request, url) {
    const baseKey = offlineKey(url.toString());
    const range = request.headers.get('range');

    // Conservative gate: only intercept fully-cached entries.
    if (!experimentalPartialCache) {
        if (!cachedKeys.has(completeKeyOf(baseKey)) && !cachedKeys.has(baseKey)) return null;
        return handleCrossOrigin(request);
    }

    // Partial gate: intercept when the requested Range starts inside a cached
    // chunk; serveChunked streams the cached run and bridges the rest from
    // the network. Every decision is logged.
    const meta = cachedMetas?.get(baseKey);
    const chunkSet = cachedChunks?.get(baseKey);
    if (meta) {
        const fits = rangeStartCached(range, meta, chunkSet);
        debugLog('audio', {
            url: baseKey,
            range,
            chunks: chunkSet ? chunkSet.size : 0,
            numChunks: meta.numChunks,
            totalSize: meta.totalSize,
            decision: fits ? 'intercept' : 'passthrough',
        });
        return fits ? handleCrossOriginLogged(request, baseKey, range) : null;
    }
    if (cachedKeys.has(baseKey)) {
        debugLog('audio', { url: baseKey, range, decision: 'intercept-legacy' });
        return handleCrossOriginLogged(request, baseKey, range);
    }
    debugLog('audio', { url: baseKey, range, decision: 'passthrough-no-meta' });
    return null;
}

// Wraps handleCrossOrigin to log what was returned. Helps spot
// Content-Range/Content-Length/Content-Type mismatches between cache-served
// and network-served responses, which is the leading hypothesis for the
// iOS audio-element cancel behavior under the experimental gate.
async function handleCrossOriginLogged(request, baseKey, range) {
    try {
        const res = await handleCrossOrigin(request);
        debugLog('served', {
            url: baseKey,
            range,
            status: res.status,
            contentType: res.headers.get('content-type'),
            contentRange: res.headers.get('content-range'),
            contentLength: res.headers.get('content-length'),
        });
        return res;
    } catch (err) {
        debugLog('serve-error', { url: baseKey, range, err: String(err) });
        throw err;
    }
}

function completeKeyOf(baseKey) {
    return baseKey + (baseKey.includes('?') ? '&' : '?') + '__complete=1';
}

// Synchronously decide whether to intercept. Only requires the *first*
// chunk overlapping the request to be cached — serveChunked then streams
// as many contiguous cached chunks as it can. The audio element will issue
// one further Range request for the gap, which the SW passes through.
function rangeStartCached(rangeHeader, meta, chunkSet) {
    if (!chunkSet || !chunkSet.size) return false;
    const { chunkSize, numChunks, totalSize } = meta;
    if (!rangeHeader) return chunkSet.size === numChunks; // no-Range path needs everything
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!m) return false;
    const start = parseInt(m[1], 10);
    if (start >= totalSize) return false;
    const startChunk = Math.floor(start / chunkSize);
    return chunkSet.has(startChunk);
}

// Cache key with auth token stripped so URLs match across token rotations.
function offlineKey(url) {
    const u = new URL(url);
    u.searchParams.delete('token');
    return u.toString();
}

const COVER_PATH_RE = /\/api\/(items\/[^/]+\/cover|authors\/[^/]+\/image)$/;
function isCoverUrl(url) {
    return COVER_PATH_RE.test(url.pathname);
}

async function handleCover(request) {
    const cache = await caches.open(COVERS_CACHE);
    const key = offlineKey(request.url);
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
        const res = await fetch(request);
        // <img>-initiated requests are no-cors, so the response is opaque and
        // res.ok is false even on success — cache those too or the cover cache
        // never populates from normal UI loads.
        if (res.ok || res.type === 'opaque') {
            cache.put(key, res.clone()).then(() => evictCovers(cache)).catch(() => {});
        }
        return res;
    } catch {
        return new Response(null, { status: 503 });
    }
}

// cache.keys() returns insertion order — delete the oldest entries when over
// the cap. Throttled so it doesn't run on every put.
let coverEvictBusy = false;
async function evictCovers(cache) {
    if (coverEvictBusy) return;
    coverEvictBusy = true;
    try {
        const keys = await cache.keys();
        const excess = keys.length - MAX_COVERS;
        if (excess <= 0) return;
        for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    } finally { coverEvictBusy = false; }
}

// Cache keys for chunked entries. Fragments (#) are stripped by the Cache
// API, so we use query params, which are preserved.
function chunkKey(baseKey, i) {
    return baseKey + (baseKey.includes('?') ? '&' : '?') + '__chunk=' + i;
}
function metaKeyOf(baseKey) {
    return baseKey + (baseKey.includes('?') ? '&' : '?') + '__meta=1';
}

async function handleCrossOrigin(request) {
    const baseKey = offlineKey(request.url);
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);

    // Chunked format (large files): meta entry tells us how to assemble.
    const metaRes = await cache.match(metaKeyOf(baseKey));
    if (metaRes) {
        try {
            const meta = await metaRes.json();
            return await serveChunked(request, cache, baseKey, meta);
        } catch {
            // Fall through to other strategies if meta is corrupt
        }
    }

    // Legacy whole-file format (covers, small files).
    const cached = await cache.match(baseKey);
    if (cached) return serveCached(request, cached);

    return fetch(request);
}

const SAFE_SLICE_LIMIT = 50 * 1024 * 1024;
// Historical cap on bytes per 206 from serveChunked, from when wide Ranges
// (e.g. "bytes=N-") eagerly concatenated every overlapping chunk into the JS
// heap and OOMed iOS PWA (~50 MB budget). The pull-based ReadableStream in
// serveChunked now bounds memory via backpressure (~one 10 MB chunk in
// flight), so this cap is no longer enforced. Kept for reference; if
// serveChunked ever returns to eager assembly, re-wire this cap first.
const MAX_RANGE_SLICE = 4 * 1024 * 1024;

// Serve a cached full-body response, slicing into a 206 if the request has
// Range. For files larger than SAFE_SLICE_LIMIT we refuse to load the body
// into memory (would OOM iOS PWA on legacy whole-file caches). In that case
// we return the response as-is and let the audio element handle it.
async function serveCached(request, cachedResponse) {
    const range = request.headers.get('range');
    if (!range) return cachedResponse;
    const lenHeader = parseInt(cachedResponse.headers.get('content-length') || '0', 10);
    if (lenHeader === 0 || lenHeader > SAFE_SLICE_LIMIT) {
        return cachedResponse;
    }
    const buf = await cachedResponse.arrayBuffer();
    const total = buf.byteLength;
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (!m) return cachedResponse;
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    const chunk = buf.slice(start, end + 1);
    return new Response(chunk, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': cachedResponse.headers.get('content-type') || 'audio/mpeg',
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

// Serve a chunked file: each #chunk=N entry is a CHUNK_SIZE-bytes slab. For
// Range requests we look up just the chunks that overlap the requested range
// and stitch them together. For non-Range we stream all chunks in order.
async function serveChunked(request, cache, baseKey, meta) {
    const { contentType, totalSize, chunkSize, numChunks } = meta;
    const range = request.headers.get('range');

    if (!range) {
        // If any chunk is missing, the partial assembly would break — better
        // to let the network serve the whole thing.
        for (let i = 0; i < numChunks; i++) {
            if (!(await cache.match(chunkKey(baseKey, i)))) return fetch(request);
        }
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for (let i = 0; i < numChunks; i++) {
                        const c = await cache.match(chunkKey(baseKey, i));
                        if (!c) { controller.error(new Error('missing chunk ' + i)); return; }
                        controller.enqueue(new Uint8Array(await c.arrayBuffer()));
                    }
                    controller.close();
                } catch (err) { controller.error(err); }
            },
        });
        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': contentType || 'audio/mpeg',
                'Content-Length': String(totalSize),
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    // Content-Range "bytes */<total>" on 416 lets the client learn the real
    // size after probing with a stale range (e.g. post-eviction).
    const unsatisfiable = () => new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` },
    });
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (!m) return unsatisfiable();
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
    if (start > end || start >= totalSize) return unsatisfiable();

    const startChunk = Math.floor(start / chunkSize);
    const requestEndChunk = Math.min(Math.floor(end / chunkSize), numChunks - 1);

    // Find the contiguous cached run starting from the request offset.
    const chunkSet = cachedChunks?.get(baseKey) || new Set();
    let lastContiguousChunk = startChunk;
    for (let i = startChunk + 1; i <= requestEndChunk; i++) {
        if (!chunkSet.has(i)) break;
        lastContiguousChunk = i;
    }
    const cacheEnd = Math.min(end, (lastContiguousChunk + 1) * chunkSize - 1, totalSize - 1);
    const needsNetwork = cacheEnd < end;
    const totalLength = end - start + 1;

    // Bridged stream: pull cached chunks first, then pipe network bytes for
    // any gap that follows. The audio element sees ONE continuous response
    // covering the full requested Range — like conservative-gate passthrough,
    // but with the cached prefix served instantly. Earlier "stop at cache
    // end and make the audio element issue a new Range" design broke iOS
    // playback (the audio element couldn't reconnect cleanly across the
    // cache→network seam).
    let cur = startChunk;
    let networkReader = null;
    let networkAbort = null;
    // Start the gap fetch NOW, not when the cached run is consumed: the
    // shim's cold first byte (8-16 s measured 2026-09-03) then overlaps the
    // minutes of cached audio instead of landing mid-stream as a stall at
    // the seam. The body stays unread (TCP backpressure) until we get there.
    // One retry: the shim retries pCloud itself, but a 5xx here would
    // otherwise truncate the response and send iOS into a re-request loop.
    const networkResP = needsNetwork ? (async () => {
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const headers = new Headers(request.headers);
                headers.set('Range', `bytes=${cacheEnd + 1}-${end}`);
                networkAbort = new AbortController();
                const res = await fetch(request.url, { headers, signal: networkAbort.signal });
                if (res.status === 206 || res.status === 200) return res;
                lastErr = new Error('network fetch ' + res.status);
                try { res.body?.cancel(); } catch {}
            } catch (err) { lastErr = err; if (networkAbort?.signal.aborted) break; }
        }
        throw lastErr || new Error('network fetch failed');
    })() : null;
    if (networkResP) networkResP.catch(() => {}); // cancelled before use is not an error

    const stream = new ReadableStream({
        async pull(controller) {
            // Cache phase.
            if (cur <= lastContiguousChunk) {
                try {
                    const c = await cache.match(chunkKey(baseKey, cur));
                    if (!c) { controller.error(new Error('chunk evicted: ' + cur)); return; }
                    const buf = await c.arrayBuffer();
                    const chunkStartByte = cur * chunkSize;
                    const sliceStart = Math.max(0, start - chunkStartByte);
                    const sliceEnd = Math.min(buf.byteLength, cacheEnd - chunkStartByte + 1);
                    controller.enqueue(new Uint8Array(buf, sliceStart, sliceEnd - sliceStart));
                    cur++;
                } catch (err) { controller.error(err); }
                return;
            }
            // Network phase.
            if (!needsNetwork) { controller.close(); return; }
            if (!networkReader) {
                try {
                    const res = await networkResP;
                    networkReader = res.body.getReader();
                } catch (err) { controller.error(err); return; }
            }
            try {
                const { value, done } = await networkReader.read();
                if (done) { controller.close(); return; }
                controller.enqueue(value);
            } catch (err) { controller.error(err); }
        },
        cancel() {
            try { networkAbort?.abort(); } catch {}
        },
    });

    return new Response(stream, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': contentType || 'audio/mpeg',
            'Content-Length': String(totalLength),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
