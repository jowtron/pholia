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
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => !KEEP_CACHES.has(k)).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

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
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    const cached = await cache.match(offlineKey(request.url));
    if (cached) return serveCached(request, cached);
    return fetch(request);
}

// Serve a cached full-body response, slicing into a 206 if the request has Range.
async function serveCached(request, cachedResponse) {
    const range = request.headers.get('range');
    if (!range) return cachedResponse;
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
