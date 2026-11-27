const SW_VERSION = 'v9';
const CACHE_NAME = 'student-mgr-' + SW_VERSION;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  const isNav = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js';
  event.respondWith(
    fetch(event.request, isNav ? { cache: 'no-store' } : undefined).catch(() => caches.match(event.request))
  );
});
