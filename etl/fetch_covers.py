"""Download one cover per DC issue/book and save small JPEG thumbnails named by GCD id.

Run from your own terminal (macOS: uses `sips` to resize; elsewhere needs Pillow):
  export METRON_USER='...'; export METRON_PASS='...'
  python3 ~/Documents/comics-db/etl/fetch_covers.py            # everything
  python3 ~/Documents/comics-db/etl/fetch_covers.py --limit 200   # quick trial

Sources, in order: Metron (issues, and books Metron knows) -> Open Library by ISBN -> Google Books by ISBN.
Safe to stop and re-run: listings are cached in raw/metron_cache/ and existing thumbnails are skipped.
Output: covers/<gcd_id>.jpg (max 400 px tall) + covers/manifest.json (source of each cover).
"""
import argparse, base64, concurrent.futures as cf, gzip, json, os, pathlib, re, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
RAW = ROOT / "raw"; CACHE = RAW / "metron_cache"; OUT = ROOT / "covers"
UA = "longbox-covers/0.1 (personal catalog)"
ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=0, help="only download this many new covers")
ap.add_argument("--workers", type=int, default=4)
ap.add_argument("--size", type=int, default=400, help="max thumbnail height in px")
ap.add_argument("--skip-books", action="store_true")
args = ap.parse_args()
CACHE.mkdir(parents=True, exist_ok=True); OUT.mkdir(exist_ok=True)

def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

# ---------- catalog ----------
cat_path = RAW / "catalog.sqlite"
if not cat_path.exists():
    gz = RAW / "catalog.sqlite.gz"
    if not gz.exists(): sys.exit(f"Missing {gz}")
    log("unpacking catalog.sqlite.gz"); shutil.copyfileobj(gzip.open(gz), open(cat_path, "wb"))
db = sqlite3.connect(cat_path)
issues = db.execute("""select i.id, i.series_id, i.number, i.isbn, i.kind from issue i""").fetchall()
log(f"catalog: {len(issues)} issues/books")
def num_key(n):
    n = (n or "").strip().strip("[]").lower().lstrip("#")
    return (n.lstrip("0") or "0") if n.isdigit() else n
by_series_num = {(sid, num_key(n)): iid for iid, sid, n, _, _ in issues}

# ---------- Metron (authenticated JSON API, max 20 req/min) ----------
user, pw = os.environ.get("METRON_USER"), os.environ.get("METRON_PASS")
AUTH = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode() if user and pw else None
_last = [0.0]
def metron(path):
    cache = CACHE / (re.sub(r"[^a-z0-9]+", "_", path.lower()).strip("_") + ".json")
    if cache.exists(): return json.loads(cache.read_text())
    if not AUTH: return None
    wait = 3.1 - (time.time() - _last[0])
    if wait > 0: time.sleep(wait)
    for attempt in range(5):
        _last[0] = time.time()
        req = urllib.request.Request("https://metron.cloud/api/" + path, headers={"Authorization": AUTH, "User-Agent": UA})
        try:
            data = json.loads(urllib.request.urlopen(req, timeout=60).read())
            cache.write_text(json.dumps(data)); return data
        except urllib.error.HTTPError as e:
            if e.code == 429: log("Metron rate limit, waiting 60 s"); time.sleep(60); continue
            if e.code == 401: sys.exit("Metron rejected the credentials (401). Check METRON_USER / METRON_PASS.")
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            log("network error, retrying:", e); time.sleep(10 * (attempt + 1))
    raise RuntimeError("Metron keeps failing for " + path)

def metron_all(path):
    out, page = [], 1
    while True:
        d = metron(f"{path}{'&' if '?' in path else '?'}page={page}")
        if not d: break
        out += d.get("results", [])
        if page == 1: log(f"  {path}: {d.get('count')} rows, {-(-d.get('count', 0) // 100)} pages")
        if page % 25 == 0: log(f"  {path}: page {page} of {-(-d.get('count', 0) // 100)}")
        if not d.get("next"): break
        page += 1
    return out

wanted = {}  # gcd_id -> (url, source)
if AUTH or any(CACHE.iterdir()):
    log("Metron: series list (to map Metron series -> GCD series)")
    series = metron_all("series/?publisher_id=2")
    m2g = {s["id"]: s.get("gcd_id") for s in series if s.get("gcd_id")}
    log(f"  {len(m2g)} of {len(series)} Metron series carry a GCD id")
    log("Metron: issue list (each row has its cover URL)")
    rows = metron_all("issue/?publisher_id=2")
    hit = 0
    for r in rows:
        g = m2g.get((r.get("series") or {}).get("id"))
        iid = by_series_num.get((g, num_key(r.get("number")))) if g else None
        if iid and r.get("image"): wanted[iid] = (r["image"], "metron"); hit += 1
    log(f"  matched {hit} of {len(rows)} Metron issues to the catalog")
else:
    log("No METRON_USER/METRON_PASS: skipping Metron (issue covers need it).")

# ---------- books without a Metron cover: Open Library, then Google Books ----------
def isbns(raw):
    out = []
    for x in (raw or "").split(";"):
        d = re.sub(r"[^0-9Xx]", "", x)
        if len(d) in (10, 13): out.append(d.upper())
    return out
def http_ok(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r: return r.status == 200 and int(r.headers.get("Content-Length") or 2000) > 1000
    except Exception: return False
def book_source(raw_isbn):
    for i in isbns(raw_isbn):
        u = f"https://covers.openlibrary.org/b/isbn/{i}-L.jpg?default=false"
        if http_ok(u): return u, "openlibrary"
    for i in isbns(raw_isbn):
        try:
            req = urllib.request.Request(f"https://www.googleapis.com/books/v1/volumes?q=isbn:{i}", headers={"User-Agent": UA})
            d = json.loads(urllib.request.urlopen(req, timeout=20).read())
            links = ((d.get("items") or [{}])[0].get("volumeInfo") or {}).get("imageLinks") or {}
            u = links.get("thumbnail") or links.get("smallThumbnail")
            if u: return u.replace("http://", "https://").replace("&edge=curl", "").replace("zoom=1", "zoom=2"), "googlebooks"
        except Exception: pass
        time.sleep(0.5)
    return None

manifest_path = OUT / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
todo_books = [] if args.skip_books else [(iid, isbn) for iid, sid, n, isbn, kind in issues
                                          if kind == "book" and iid not in wanted and isbn and str(iid) not in manifest]
# ---------- download + resize ----------
SIPS = shutil.which("sips")
try:
    from PIL import Image  # optional fallback
except ImportError:
    Image = None
if not SIPS and not Image: sys.exit("Need macOS `sips` or `pip install pillow` to resize images.")

def save_thumb(data, dest):
    with tempfile.NamedTemporaryFile(suffix=".img", delete=False) as t: t.write(data); tmp = t.name
    try:
        if SIPS:
            r = subprocess.run([SIPS, "-s", "format", "jpeg", "-s", "formatOptions", "72", "--resampleHeight", str(args.size), tmp, "--out", str(dest)],
                               capture_output=True)
            if r.returncode != 0 or not dest.exists(): raise RuntimeError(r.stderr.decode()[:200])
        else:
            im = Image.open(tmp).convert("RGB"); im.thumbnail((args.size, args.size)); im.save(dest, "JPEG", quality=72, optimize=True)
    finally: os.unlink(tmp)

def fetch(iid, url, source):
    dest = OUT / f"{iid}.jpg"
    if dest.exists(): return iid, source, "exists"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            data = urllib.request.urlopen(req, timeout=60).read()
            if len(data) < 1000: return iid, source, "tiny"
            save_thumb(data, dest); return iid, source, "ok"
        except Exception as e:
            err = str(e); time.sleep(3 * (attempt + 1))
    return iid, source, "error: " + err[:80]

jobs = [(iid, u, s) for iid, (u, s) in wanted.items() if not (OUT / f"{iid}.jpg").exists()]
log(f"to download: {len(jobs)} from Metron, {len(todo_books)} books to look up by ISBN")
if args.limit: jobs = jobs[: args.limit]; todo_books = todo_books[: max(0, args.limit - len(jobs))]
done = 0; t0 = time.time()
def record(res):
    global done
    iid, source, status = res; done += 1
    if status in ("ok", "exists"): manifest[str(iid)] = source
    if done % 200 == 0:
        manifest_path.write_text(json.dumps(manifest))
        log(f"  {done} processed, {len(manifest)} covers in total, {done / max(1, time.time() - t0):.1f}/s")
with cf.ThreadPoolExecutor(args.workers) as ex:
    for res in ex.map(lambda j: fetch(*j), jobs): record(res)
    def book_job(item):
        iid, isbn = item
        src = book_source(isbn)
        return fetch(iid, *src) if src else (iid, None, "none")
    for res in ex.map(book_job, todo_books): record(res)
manifest_path.write_text(json.dumps(manifest))
size = sum(f.stat().st_size for f in OUT.glob("*.jpg"))
log(f"done: {len(manifest)} covers, {size / 1e6:.0f} MB in {OUT}")
by_src = {}
for v in manifest.values(): by_src[v] = by_src.get(v, 0) + 1
log("by source:", by_src)
