// Service worker: caches the app shell and the hand-tracking model/runtime so the app
// starts fast and works offline after the first load.
const CACHE = 'air-strings-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'audio.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isLocal = url.origin === location.origin;
  const isModel = /cdn\.jsdelivr\.net|storage\.googleapis\.com/.test(url.host);

  if (isLocal) {
    // Network first for app files so updates show up, cache as fallback offline.
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
  } else if (isModel) {
    // Versioned CDN files never change: cache first.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
