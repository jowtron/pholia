const CACHE_NAME = 'cadence-v1';
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

// Install: cache app shell
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for app shell
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // API requests: always go to network, never cache
    if (url.pathname.startsWith('/api/') || url.search.includes('token=')) {
        return;
    }

    // App shell: try cache first, then network (stale-while-revalidate)
    e.respondWith(
        caches.match(e.request).then(cached => {
            const networkFetch = fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return res;
            }).catch(() => cached);

            return cached || networkFetch;
        })
    );
});
