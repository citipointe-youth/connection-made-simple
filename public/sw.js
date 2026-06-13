const CACHE = 'cms-v3';
const APP_SHELL = ['/'];

// API paths that should never be served from cache. NOTE: every API resource must
// be listed here — a missing one (e.g. lifegroups) falls through to the cache-first
// asset path and can get the SPA HTML cached under its URL, breaking JSON parsing.
const API_RE = /^\/(auth|students|leaders|connections|overview|trends|lifegroups|at-risk|import|settings|admin|accounts|health)(\/|$|\?)/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Network-only for API routes (never stale data)
  if (API_RE.test(url.pathname)) return;

  // Network-first for the HTML shell — always get the latest version when online
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for all other assets (fonts, icons, etc.)
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      });
    })
  );
});
