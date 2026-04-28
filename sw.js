const CACHE_NAME = 'pholia-v4';
const OFFLINE_AUDIO_CACHE = 'pholia-offline-audio-v1';
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
                if (req.url.includes('#chunk=') || req.url.includes('#meta')) continue;
                const r = await audio.match(req);
                if (!r) continue;
                const len = parseInt(r.headers.get('content-length') || '0', 10);
                if (len > 50 * 1024 * 1024) await audio.delete(req);
            }
        } catch {}
        await self.clients.claim();
    })());
});

self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
    // Page tells us when it changed the cache — invalidate the in-memory set.
    if (e.data?.type === 'CACHE_CHANGED') cachedKeys = null;
});

// In-memory set of URLs known to be in OFFLINE_AUDIO_CACHE. Avoids two
// async disk lookups per audio Range request when nothing is cached, which
// noticeably affects streaming over slow networks (Tailscale relay etc.).
let cachedKeys = null;
async function ensureCachedKeys() {
    if (cachedKeys) return;
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

    // Cross-origin (e.g. ABS audio/cover): try offline cache, else passthrough.
    e.respondWith(handleCrossOrigin(e.request));
});

// Cache key with auth token stripped so URLs match across token rotations.
function offlineKey(url) {
    const u = new URL(url);
    u.searchParams.delete('token');
    return u.toString();
}

async function handleCrossOrigin(request) {
    const baseKey = offlineKey(request.url);

    // Fast path: if the in-memory set knows we have nothing cached for this
    // URL, skip the two cache.match disk lookups entirely. Removes ~30-100ms
    // per audio Range request when streaming uncached content.
    await ensureCachedKeys();
    if (!cachedKeys.has(baseKey + '#meta') && !cachedKeys.has(baseKey)) {
        return fetch(request);
    }

    const cache = await caches.open(OFFLINE_AUDIO_CACHE);

    // Chunked format (large files): meta entry tells us how to assemble.
    const metaRes = await cache.match(baseKey + '#meta');
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
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for (let i = 0; i < numChunks; i++) {
                        const c = await cache.match(baseKey + '#chunk=' + i);
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
        const c = await cache.match(baseKey + '#chunk=' + i);
        if (!c) return new Response(null, { status: 500 });
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
