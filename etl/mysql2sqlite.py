"""Stream a mysqldump file into SQLite, keeping only some tables. Resumable.

Usage: python3 -I mysql2sqlite.py DUMP.sql OUT.sqlite table1,table2,... [time_budget_s]
Re-run with the same args until it prints ALL DONE.
"""
import os, re, sqlite3, sys, time

dump, out, keep = sys.argv[1], sys.argv[2], set(sys.argv[3].split(","))
budget = float(sys.argv[4]) if len(sys.argv) > 4 else 1e9
ckpt = out + ".offset"

ESC = {"'": "''", "\\": "\\", "n": "\n", "r": "\r", "t": "\t", "0": "\x00",
       '"': '"', "Z": "\x1a", "b": "\b"}
esc_re = re.compile(r"\\(.)", re.S)
def unescape(s):
    return esc_re.sub(lambda m: ESC.get(m.group(1), m.group(1)), s)

col_re = re.compile(r"^\s+`([^`]+)`\s+(\w+)")
db = sqlite3.connect(out, isolation_level=None)
db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA synchronous=NORMAL")
db.execute("PRAGMA cache_size=-400000")

start = int(open(ckpt).read()) if os.path.exists(ckpt) else 0
t0 = time.time(); cur_table = None; cols = []; in_create = False
with open(dump, "rb") as f:
    f.seek(start); pos = start
    db.execute("BEGIN")
    while True:
        raw = f.readline()
        if not raw:
            db.execute("COMMIT"); open(ckpt, "w").write(str(pos)); print("ALL DONE"); break
        pos += len(raw)
        if raw.startswith(b"CREATE TABLE `"):
            cur_table = raw.split(b"`")[1].decode(); cols = []; in_create = True; continue
        if in_create:
            line = raw.decode("utf-8", "replace")
            m = col_re.match(line)
            if m:
                typ = m.group(2).lower()
                aff = "INTEGER" if "int" in typ else ("REAL" if typ in ("decimal", "float", "double") else "TEXT")
                cols.append(f'"{m.group(1)}" {aff}')
            elif line.startswith(")"):
                in_create = False
                if cur_table in keep:
                    db.execute(f'DROP TABLE IF EXISTS "{cur_table}"')
                    db.execute(f'CREATE TABLE "{cur_table}" ({", ".join(cols)})')
                    print(f"[{time.time()-t0:5.0f}s @{pos/1e9:.2f}GB] {cur_table}", flush=True)
            continue
        if raw.startswith(b"INSERT INTO `"):
            t = raw.split(b"`")[1].decode()
            if t not in keep:
                continue
            body = raw[len(t) + 14:].decode("utf-8", "replace").rstrip().rstrip(";")
            db.execute('INSERT INTO "' + t + '"' + unescape(body))
            if time.time() - t0 > budget:
                db.execute("COMMIT"); open(ckpt, "w").write(str(pos))
                print(f"PAUSED at {pos/1e9:.2f}GB of {os.path.getsize(dump)/1e9:.2f}GB"); break
