/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

export const DB_CACHE = "longbox-db";
// decoded chunks kept in memory while the worker lives, so each 4 KB range read doesn't re-read an 8 MB cache entry
const mem = new Map<string, ArrayBuffer>();
async function chunkBuffer(cache: Cache, href: string): Promise<ArrayBuffer | null> {
  const m = mem.get(href);
  if (m) return m;
  const hit = await cache.match(href, { ignoreVary: true });
  if (!hit) return null;
  const buf = await hit.arrayBuffer();
  if (mem.size >= 4) mem.delete(mem.keys().next().value as string);
  mem.set(href, buf);
  return buf;
}

/** Serve DB chunks from the offline cache when present (answering Range requests by slicing), else go to the network. */
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const method = event.request.method;
  if ((method !== "GET" && method !== "HEAD") || !url.pathname.includes("/db/")) return;
  if (url.pathname.endsWith("/db/config.json")) {
    event.respondWith(
      fetch(event.request).then(
        async (res) => {
          if (res.ok) (await caches.open(DB_CACHE)).put(url.pathname, res.clone());
          return res;
        },
        async () => (await caches.open(DB_CACHE)).match(url.pathname).then((r) => r ?? Response.error()),
      ),
    );
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(DB_CACHE);
      const buf = await chunkBuffer(cache, url.href);
      if (!buf) return fetch(event.request);
      if (method === "HEAD")
        return new Response(null, { status: 200, headers: { "Content-Length": String(buf.byteLength), "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" } });
      const range = event.request.headers.get("range");
      const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
      if (!m) return new Response(buf.slice(0), { status: 200, headers: { "Accept-Ranges": "bytes" } });
      const start = +m[1], end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
      return new Response(buf.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
          "Content-Length": String(end - start + 1),
          "Content-Type": "application/octet-stream",
          "Accept-Ranges": "bytes",
        },
      });
    })(),
  );
});
