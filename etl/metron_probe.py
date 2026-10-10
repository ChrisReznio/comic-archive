"""Probe the Metron API for DC coverage, cover images and GCD cross-references.

Run from your own terminal (stdlib only):
  export METRON_USER='tu_usuario'; export METRON_PASS='tu_password'
  python3 ~/Documents/comics-db/etl/metron_probe.py
Writes ~/Documents/comics-db/raw/metron_probe.json (no credentials stored).
"""
import base64, json, os, re, time, traceback, pathlib

BASE = "https://metron.cloud/api/"
user, pw = os.environ.get("METRON_USER"), os.environ.get("METRON_PASS")
if not user or not pw:
    raise SystemExit("Definí METRON_USER y METRON_PASS primero (ver comentario arriba).")
out_dir = pathlib.Path(__file__).resolve().parent.parent / "raw"
out_dir.mkdir(exist_ok=True)
report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "steps": []}

def get(path, raw=False):
    """GET via system curl (uses macOS keychain certs). Credentials go through stdin, never argv."""
    import subprocess
    time.sleep(3.2)  # Metron: max 20 req/min
    url = path if path.startswith("http") else BASE + path
    url = url.replace(" ", "%20")
    cred = f"{user}:{pw}".replace("\\", "\\\\").replace('"', '\\"')
    cfg = f'user = "{cred}"\n' if "metron.cloud/api" in url else ""
    t = time.time()
    p = subprocess.run(["curl", "-sS", "-L", "--max-time", "40", "-K", "-", "-A", "comics-db-probe/0.1",
                        "-D", "-", "-o", str(out_dir / ".probe_body"), url], input=cfg.encode(), capture_output=True)
    hdr = p.stdout.decode("latin-1"); body = (out_dir / ".probe_body").read_bytes() if (out_dir / ".probe_body").exists() else b""
    status = int(re.findall(r"HTTP/[\d.]+ (\d+)", hdr)[-1]) if re.findall(r"HTTP/[\d.]+ (\d+)", hdr) else None
    info = {"url": url.replace(BASE, "/api/"), "status": status, "ms": int((time.time()-t)*1000), "bytes": len(body),
            "curl_error": p.stderr.decode()[:300] or None,
            "ratelimit": [l.strip() for l in hdr.splitlines() if "rate" in l.lower() or "retry" in l.lower()]}
    if status != 200: info["body"] = body[:300].decode("utf-8", "replace")
    report["steps"].append(info); print(status, info["url"], f'{info["ms"]}ms', info["curl_error"] or "")
    if status != 200: return None
    return body if raw else json.loads(body)

try:
    pubs = get("publisher/?name=DC Comics")
    report["publishers"] = pubs and [{k: p.get(k) for k in ("id", "name")} for p in pubs["results"]]
    dc = next((p["id"] for p in (pubs or {}).get("results", []) if p["name"].lower() in ("dc comics", "dc")), None)
    report["dc_id"] = dc
    types = get("series_type/")
    report["series_types"] = types and [{k: t.get(k) for k in ("id", "name")} for t in types["results"]]
    report["dc_counts"] = {}
    if dc:
        s = get(f"series/?publisher_id={dc}"); report["dc_counts"]["all_series"] = s and s["count"]
        i = get(f"issue/?publisher_id={dc}"); report["dc_counts"]["all_issues"] = i and i["count"]
        for t in (types or {}).get("results", []):
            if any(w in t["name"].lower() for w in ("trade", "hard", "omnibus", "graphic")):
                r = get(f"series/?publisher_id={dc}&series_type_id={t['id']}")
                report["dc_counts"][t["name"]] = r and r["count"]
        samples = []
        for q in ("series_name=batman year one", "series_name=batman by grant morrison omnibus", "series_name=absolute batman"):
            r = get(f"issue/?publisher_id={dc}&{q.replace(' ', '%20')}")
            for it in (r or {}).get("results", [])[:2]:
                d = get(f"issue/{it['id']}/")
                if d:
                    samples.append({k: d.get(k) for k in ("id", "number", "isbn", "page", "image", "gcd_id", "cv_id", "cover_date")}
                                   | {"series": (d.get("series") or {}).get("name"), "series_type": ((d.get("series") or {}).get("series_type") or {}).get("name"),
                                      "reprints": [x.get("issue") for x in d.get("reprints", [])][:12], "keys": sorted(d.keys())})
        report["samples"] = samples
        img = next((x["image"] for x in samples if x.get("image")), None)
        if img:
            b = get(img, raw=True); report["image_test"] = {"url": img, "bytes": b and len(b)}
            if b: (out_dir / "metron_sample_cover.jpg").write_bytes(b)
except Exception:
    report["error"] = traceback.format_exc(); print(report["error"])
finally:
    out_dir.mkdir(exist_ok=True)
    (out_dir / "metron_probe.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print("\nListo ->", out_dir / "metron_probe.json")
