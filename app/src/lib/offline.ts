// Optional offline mode: download every DB chunk into Cache Storage; the service worker then serves range reads from it.
const DB_CACHE = "longbox-db";

interface DbConfig { databaseLengthBytes: number; serverChunkSize: number; urlPrefix: string; suffixLength: number; cacheBust?: string }

async function loadConfig(): Promise<{ cfg: DbConfig; urls: string[] }> {
  const configUrl = new URL("db/config.json", document.baseURI);
  const cfg: DbConfig = await (await fetch(configUrl)).json();
  const n = Math.ceil(cfg.databaseLengthBytes / cfg.serverChunkSize);
  const urls = Array.from({ length: n }, (_, i) => {
    const u = new URL(cfg.urlPrefix + String(i).padStart(cfg.suffixLength, "0"), configUrl);
    if (cfg.cacheBust) u.searchParams.set("cb", cfg.cacheBust);
    return u.href;
  });
  return { cfg, urls };
}

export async function offlineStatus() {
  if (!("caches" in window)) return { supported: false, cached: 0, total: 0, bytes: 0 };
  const { cfg, urls } = await loadConfig();
  const cache = await caches.open(DB_CACHE);
  let cached = 0;
  for (const u of urls) if (await cache.match(u)) cached++;
  return { supported: true, cached, total: urls.length, bytes: cfg.databaseLengthBytes };
}

export async function downloadOffline(onProgress: (done: number, total: number) => void) {
  const { urls } = await loadConfig();
  const cache = await caches.open(DB_CACHE);
  // drop chunks from older data versions
  for (const req of await cache.keys()) if (/app\.sqlite\.\d+/.test(req.url) && !urls.includes(req.url)) await cache.delete(req);
  let done = 0;
  onProgress(0, urls.length);
  for (const u of urls) {
    if (!(await cache.match(u))) {
      const res = await fetch(u, { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn’t download ${u.split("/").pop()} (${res.status})`);
      await cache.put(u, res);
    }
    onProgress(++done, urls.length);
  }
  if (navigator.storage?.persist) await navigator.storage.persist();
}

export async function removeOffline() {
  const cache = await caches.open(DB_CACHE);
  for (const req of await cache.keys()) if (/app\.sqlite\.\d+/.test(req.url)) await cache.delete(req);
}
