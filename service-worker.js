// App-shell cache only — never caches data. All coaching data comes from
// the GitHub API at request time (see app.js); caching that would risk
// showing stale training/health data, which matters a lot more here than
// offline access does. Bump CACHE_NAME on EVERY shell file change (even a
// CSS/JS-only edit) — the browser only checks for a new service worker by
// byte-comparing this file against the installed one, so if this file's
// bytes don't change, no update is ever detected and clients stay on the
// old cached shell indefinitely, however much app.js/style.css changed.
const CACHE_NAME = "coach-shell-v6";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls (GitHub, etc.) — always go to the network so
  // data is never served stale from cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
