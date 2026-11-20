const CACHE_NAME = 'gtv-hub-v35';
const DYNAMIC_CACHE = 'gtv-dynamic-v2';
const ASSETS = [
  './',
  './index.html',
  './email-confirmed.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cache) => {
            if (cache !== CACHE_NAME) {
              return caches.delete(cache);
            }
          })
        );
      })
    ])
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 1. TMDB Images - Cache First (Performance)
  if (url.hostname === 'image.tmdb.org') {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => cache.put(e.request, responseToCache));
          }
          return response;
        });
      })
    );
    return;
  }

  // 2. TMDB API - Network First (Fresh Data)
  if (url.hostname === 'api.themoviedb.org') {
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(DYNAMIC_CACHE).then((cache) => cache.put(e.request, responseToCache));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request).catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
