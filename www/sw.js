// Bump this on every release that changes index.html/style.css/script.js.
// Changing this string changes sw.js's own bytes, which is what makes the
// browser/WebView notice there's a new service worker, install it, and
// (via 'activate' below) delete the old cache — without a bump here, a
// previously-installed app will keep serving stale shell files forever,
// even after you fix a bug and ship a new build.
const CACHE_VERSION = 'v2';
const CACHE = `wavelength-shell-${CACHE_VERSION}`;
const SHELL = ['./', './index.html', './style.css', './script.js', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell: always try to fetch the latest file
// first, and only fall back to whatever's cached when there's no
// connection. This is what actually lets bug fixes reach the installed
// app — a cache-first strategy (the previous behavior) would silently
// keep serving old, broken files indefinitely.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
  );
});
