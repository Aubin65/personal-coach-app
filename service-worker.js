// App-shell cache only — never caches data. All coaching data comes from
// the GitHub API at request time (see app.js); caching that would risk
// showing stale training/health data, which matters a lot more here than
// offline access does. Bump CACHE_NAME on EVERY shell file change (even a
// CSS/JS-only edit) — the browser only checks for a new service worker by
// byte-comparing this file against the installed one, so if this file's
// bytes don't change, no update is ever detected and clients stay on the
// old cached shell indefinitely, however much app.js/style.css changed.
const CACHE_NAME = "coach-shell-v14";
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

// Web Push (VAPID, see docs/adr/0025) — the payload is our own JSON
// {title, body, url}, written by src/coach/push.py. Falls back to a
// generic notification if the payload can't be parsed (a push service is
// allowed to deliver an empty "wake up and check" ping) rather than
// dropping the event silently.
self.addEventListener("push", (event) => {
  let payload = { title: "Coach", body: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_) { /* keep the generic fallback */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: payload.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || "./", self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.startsWith(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
