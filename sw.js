const CACHE_NAME = 'pholia-v3';
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

// Install: cache app shell but DON'T skipWaiting — wait for the app to tell us
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
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

// When the app tells us to activate, do it immediately
self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Fetch: network-first for app files, passthrough for API/external
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) return;

    // Network-first: try network, fall back to cache (offline support)
    e.respondWith(
        fetch(e.request).then(res => {
            if (res.ok) {
                const clone = res.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
            }
            return res;
        }).catch(() => caches.match(e.request))
    );
});
