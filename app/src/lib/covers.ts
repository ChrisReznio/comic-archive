// Cover images are served as static files named by GCD issue id: {base}/{id}.jpg
// Set VITE_COVERS_BASE at build time (e.g. a Cloudflare R2 public bucket URL). Without it, the app draws placeholders.
const base = (import.meta.env.VITE_COVERS_BASE as string | undefined)?.replace(/\/$/, "") || "";

export function coverUrl(id: number): string | null {
  return base ? `${base}/${id}.jpg` : null;
}
