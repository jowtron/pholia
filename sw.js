const CACHE_NAME = 'pholia-v4';
const OFFLINE_AUDIO_CACHE = 'pholia-offline-audio-v2';
const OFFLINE_META_CACHE = 'pholia-offline-meta-v1';
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './api.js',
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

const KEEP_CACHES = new Set([CACHE_NAME, OFFLINE_AUDIO_CACHE, OFFLINE_META_CACHE]);

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => !KEEP_CACHES.has(k)).map(k => caches.delete(k)));
        // Purge legacy whole-file entries larger than 50 MB. They OOM the tab
        // when the SW tries to slice them in serveCached.
        try {
            const audio = await caches.open(OFFLINE_AUDIO_CACHE);
            const audioKeys = await audio.keys();
            for (const req of audioKeys) {
                if (req.url.includes('__chunk=') || req.url.includes('__meta=')) continue;
                const r = await audio.match(req);
                if (!r) continue;
                const len = parseInt(r.headers.get('content-length') || '0', 10);
                if (len > 50 * 1024 * 1024) await audio.delete(req);
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
    // Page tells us when it changed the cache — refresh the in-memory set.
    if (e.data?.type === 'CACHE_CHANGED') loadCachedKeys();
});

// Synchronously available set of URLs known to be in OFFLINE_AUDIO_CACHE.
// Critical for the fetch handler to decide whether to intercept at all: if
// we don't intercept (don't call respondWith), the browser handles the
// request natively with no SW overhead. iOS WebKit has measurable per-request
// latency for SW-intercepted media fetches, so passthrough must be skipped
// for uncached URLs to keep streaming smooth.
let cachedKeys = null;
async function loadCachedKeys() {
    const set = new Set();
    try {
        const cache = await caches.open(OFFLINE_AUDIO_CACHE);
        const keys = await cache.keys();
        for (const req of keys) set.add(req.url);
    } catch {}
    cachedKeys = set;
}

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    if (url.origin === self.location.origin) {
        // App shell: network-first, cache fallback when offline.
        e.respondWith(
            fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return res;
            }).catch(() => caches.match(e.request))
        );
        return;
    }

    // Cross-origin: only intercept if we know something is cached for this
    // URL. Otherwise return without calling respondWith so the browser
    // handles the request natively (no SW round-trip overhead).
    if (cachedKeys === null) {
        // Keys not yet loaded — kick off load and bail. The browser will
        // handle this request natively. Subsequent requests will use the
        // populated set.
        loadCachedKeys();
        return;
    }
    const baseKey = offlineKey(url.toString());
    if (!cachedKeys.has(metaKeyOf(baseKey)) && !cachedKeys.has(baseKey)) {
        return; // not cached — let browser fetch natively
    }
    e.respondWith(handleCrossOrigin(e.request));
});

// Cache key with auth token stripped so URLs match across token rotations.
function offlineKey(url) {
    const u = new URL(url);
    u.searchParams.delete('token');
    return u.toString();
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
            },
        });
    }

    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (!m) return new Response(null, { status: 416 });
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
    if (start > end || start >= totalSize) return new Response(null, { status: 416 });

    const startChunk = Math.floor(start / chunkSize);
    const endChunk = Math.floor(end / chunkSize);
    const parts = [];
    for (let i = startChunk; i <= endChunk; i++) {
        const c = await cache.match(chunkKey(baseKey, i));
        // Missing chunk (likely evicted): fall through to network for the
        // whole Range request rather than returning a partial/error response.
        if (!c) return fetch(request);
        const buf = await c.arrayBuffer();
        const chunkStart = i * chunkSize;
        const localStart = Math.max(0, start - chunkStart);
        const localEnd = Math.min(buf.byteLength, end - chunkStart + 1);
        parts.push(buf.slice(localStart, localEnd));
    }
    const blob = new Blob(parts, { type: contentType || 'audio/mpeg' });
    return new Response(blob, {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': contentType || 'audio/mpeg',
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
        },
    });
}
