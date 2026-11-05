// Buddy Desktop service worker — a pass-through, on purpose.
// The app IS a local server on 127.0.0.1:7822; there is nothing to take
// offline and nothing to cache. The worker exists only so the browser can
// offer "Install app" (own launcher entry, own window, own icon) without
// ever faking an offline capability the local server does not have.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method === 'GET') e.respondWith(fetch(e.request));
});
