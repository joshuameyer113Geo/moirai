/* Moirai service worker: caches the app shell for offline use.
   Never caches API calls (POSTs to OpenAI/Anthropic/xAI pass straight through). */
const VERSION = "moirai-v4";
const ICON_VARIANTS = ["neon-cauldron", "thread-weavers", "arcane", "classic"];
const ICON_FILES = ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-192.png",
  "icon-maskable-512.png", "apple-touch-icon.png", "favicon-32.png"];
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "icon.svg",
  "fonts/ShareTechMono-Regular.woff2",
  ...ICON_VARIANTS.flatMap(v => ICON_FILES.map(f => `icons/${v}/${f}`))
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  // Navigations: network-first (fresh deploys), fall back to cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put("index.html", copy)); return res;
    }).catch(() => caches.match("index.html").then(r => r || caches.match("./"))));
    return;
  }

  // Other same-origin assets: stale-while-revalidate.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
