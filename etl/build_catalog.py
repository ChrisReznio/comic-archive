"""Build the app catalog (DC only) from a full GCD SQLite conversion.

Usage: python3 -I build_catalog.py gcd.sqlite catalog.sqlite [overrides.csv]
Content of each book is resolved, in priority order, from:
  1. gcd_link  - GCD reprint links, following chains through earlier editions back to the original issues
  2. notes     - parsing the book's 'Collects ...' notes
  3. twin      - copying from another edition with the same title/volume and similar page count
  4. self      - original graphic novels / books with no reprinted content (the book is its own content)
  5. override  - manual corrections from overrides.csv (add/remove)
"""
import collections, csv, os, re, sqlite3, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from notes_parser import parse_collects

SRC, OUT = sys.argv[1], sys.argv[2]
OVR = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "overrides.csv")
DC = 54
t0 = time.time()
def log(*a): print(f"[{time.time()-t0:5.1f}s]", *a, flush=True)

g = sqlite3.connect(SRC); q = lambda s, *a: g.execute(s, a).fetchall()
CONTENT_TYPES = {19, 21, 13, 5, 9, 14, 15, 4, 20, 1}  # comic/text/photo story, cartoon, filler, illustration, profile, bio, article, activity

# ---------- series & issues ----------
def is_book(pub_type, pf, binding):
    pf, b = (pf or "").lower(), (binding or "").lower()
    return pub_type == 1 or "collect" in pf or "graphic novel" in pf or "hardcover" in b or "trade" in b
series = {}
for r in q("""select id, name, sort_name, year_began, year_ended, publication_type_id, publishing_format, binding, issue_count, publisher_id, notes
              from gcd_series where deleted=0"""):
    series[r[0]] = dict(id=r[0], name=r[1], sort_name=r[2], year_began=r[3], year_ended=r[4], book=is_book(r[5], r[6], r[7]),
                        pf=r[6] or "", binding=r[7] or "", issue_count=r[8], publisher_id=r[9])
issue_series = {}; dc_issues = {}
for r in q("""select i.id, i.series_id, i.number, i.title, i.key_date, i.on_sale_date, i.page_count, i.price, i.isbn, i.barcode,
                     coalesce(i.variant_of_id,0), i.variant_name, i.notes, i.sort_code, i.volume
              from gcd_issue i where i.deleted=0"""):
    issue_series[r[0]] = r[1]
    s = series.get(r[1])
    if s and s["publisher_id"] == DC and r[10] == 0:
        dc_issues[r[0]] = dict(id=r[0], series_id=r[1], number=r[2], title=r[3], key_date=r[4], on_sale_date=r[5], page_count=r[6],
                               price=r[7], isbn=r[8], barcode=r[9], notes=r[12] or "", sort_code=r[13], volume=r[14])
def kind(iid):
    s = series.get(issue_series.get(iid)); return None if s is None else ("book" if s["book"] else "periodical")
books = [i for i in dc_issues if series[dc_issues[i]["series_id"]]["book"]]
periodicals = [i for i in dc_issues if not series[dc_issues[i]["series_id"]]["book"]]
log(f"DC base issues {len(dc_issues)}: {len(periodicals)} periodicals, {len(books)} books")

# ---------- 1. reprint links with chain resolution ----------
story_issue, story_type, story_pages = {}, {}, {}
for sid, iid, t, pg in q("select id, issue_id, type_id, page_count from gcd_story where deleted=0"):
    story_issue[sid] = iid; story_type[sid] = t; story_pages[sid] = pg or 0
s_par = collections.defaultdict(set); i_par = collections.defaultdict(set)
for o, t, oi, ti in q("select origin_id, target_id, origin_issue_id, target_issue_id from gcd_reprint"):
    if o and t: s_par[t].add(("s", o))
    elif t and oi: s_par[t].add(("i", oi))
    elif ti and o: i_par[ti].add(("s", o))
    elif ti and oi: i_par[ti].add(("i", oi))
book_stories = collections.defaultdict(list)
issue_comic = collections.defaultdict(list)  # issue -> [(story, pages)] of comic stories, to measure partial reprints
for sid, iid in story_issue.items():
    if story_type[sid] in CONTENT_TYPES and kind(iid) == "book": book_stories[iid].append(sid)
    if story_type[sid] == 19: issue_comic[iid].append((sid, story_pages[sid]))
# Root tokens: ("s", story_id) = one original story; ("i", issue_id) = a whole original issue
smemo, imemo = {}, {}
def roots_story(sid, depth=0):
    if sid in smemo: return smemo[sid]
    smemo[sid] = set(); out = set()
    for t, p in s_par.get(sid, ()):
        if depth > 15: break
        if t == "i": out |= roots_issue(p, depth + 1)
        else:
            pi = story_issue.get(p)
            if pi is None: continue
            out |= roots_story(p, depth + 1) if kind(pi) == "book" and p in s_par else {("s", p)}
    smemo[sid] = out; return out
def roots_issue(iid, depth=0):
    if iid in imemo: return imemo[iid]
    if kind(iid) != "book": imemo[iid] = {("i", iid)}; return imemo[iid]
    imemo[iid] = set(); out = set()
    for sid in book_stories.get(iid, ()): out |= roots_story(sid, depth + 1)
    for t, v in i_par.get(iid, ()):
        if t == "s":
            vi = story_issue.get(v)
            out |= roots_story(v, depth + 1) if kind(vi) == "book" and v in s_par else ({("s", v)} if vi else set())
        else: out |= roots_issue(v, depth + 1)
    imemo[iid] = out; return out
def tokens_to_issues(tokens):
    """issue -> partial flag. Whole-issue tokens are full; story tokens are full if they cover >= 60% of the comic pages."""
    by_issue = collections.defaultdict(set); whole = set()
    for t, v in tokens:
        if t == "i": whole.add(v)
        else:
            iid = story_issue.get(v)
            if iid: by_issue[iid].add(v)
    out = {i: 0 for i in whole}
    for iid, sids in by_issue.items():
        if iid in out: continue
        comic = issue_comic.get(iid, [])
        if not comic: out[iid] = 0; continue
        tot = sum(p for _, p in comic); got = sum(p for s2, p in comic if s2 in sids)
        if tot > 0: ratio = got / tot
        else: ratio = sum(1 for s2, _ in comic if s2 in sids) / len(comic)
        out[iid] = 0 if ratio >= 0.6 else 1
    return out
content = {}  # book_id -> {issue_id: (source, partial)}
partial_n = 0
for b in books:
    rs = {i: p for i, p in tokens_to_issues(roots_issue(b)).items() if i in dc_issues and i != b}
    if rs:
        content[b] = {i: ("gcd_link", p) for i, p in rs.items()}; partial_n += sum(rs.values())
log(f"   partial issue links: {partial_n}")
log(f"1. gcd_link: {len(content)} books")

# ---------- 2. notes parsing ----------
def norm(s):
    s = (s or "").lower().replace("&", "and")
    s = re.sub(r"^(the|a)\s+", "", s); s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()
by_name = collections.defaultdict(list)
for s in series.values():
    if s["publisher_id"] == DC: by_name[norm(s["name"])].append(s)
series_issues = collections.defaultdict(list)
for i in dc_issues: series_issues[dc_issues[i]["series_id"]].append(i)
for k in series_issues: series_issues[k].sort(key=lambda i: dc_issues[i]["sort_code"] or 0)
def find_num(sid, num):
    num = num.strip().lstrip("#").strip()
    for idx, i in enumerate(series_issues[sid]):
        n = (dc_issues[i]["number"] or "").strip("[]")
        if n == num or n.lstrip("0") == num.lstrip("0"): return idx
    return None
def resolve_ref(ref, book_year):
    cands = by_name.get(norm(ref["name"]), [])
    if ref["year"]: cands = [c for c in cands if c["year_began"] == ref["year"]] or cands
    firsts = [a for a, _ in ref["ranges"] if a]
    if firsts: cands = [c for c in cands if all(find_num(c["id"], a) is not None for a in firsts)]
    if not cands: return None
    cands.sort(key=lambda c: (c["book"], (c["year_began"] or 0) > (book_year or 9999), -(c["year_began"] or 0)))
    sid = cands[0]["id"]; seq = series_issues[sid]; out = []
    for a, b in ref["ranges"]:
        if not a:  # whole series (one-shot / mini referenced by name)
            out += seq if len(seq) <= 24 else []; continue
        ia = find_num(sid, a); ib = find_num(sid, b) if b else ia
        if ia is not None and ib is not None and ib >= ia: out += seq[ia:ib + 1]
    # a referenced book (e.g. prestige one-shot shelved as book) contributes its own originals, or itself if original
    exp = []
    for i in out:
        if kind(i) == "book":
            r = {x for x in tokens_to_issues(roots_issue(i)) if x in dc_issues and x != i}
            exp += list(r) if r else [i]
        else: exp.append(i)
    return exp
notes_stats = collections.Counter(); unresolved = []
for b in books:
    if b in content: continue
    refs = parse_collects(dc_issues[b]["notes"])
    if not refs: continue
    notes_stats["books_with_collects_note"] += 1
    year = int(dc_issues[b]["key_date"][:4]) if (dc_issues[b]["key_date"] or "")[:4].isdigit() else None
    got = {}
    for ref in refs:
        r = resolve_ref(ref, year)
        if r: notes_stats["refs_ok"] += 1; got.update({i: ("notes", int(ref["partial"])) for i in r})
        else: notes_stats["refs_failed"] += 1; unresolved.append((b, ref["raw"]))
    if got: content[b] = got; notes_stats["books_resolved"] += 1
log("2. notes:", dict(notes_stats))

# ---------- 3. twins ----------
EDITION_WORDS = r"\b(deluxe|edition|hardcover|softcover|paperback|tpb|hc|new|the|absolute|noir|compact|comics|dc|library|collectors?|anniversary|\d+th|special|exclusive|barnes|noble|direct|market|book|unwrapped)\b"
def tnorm(b):
    s = norm(series[dc_issues[b]["series_id"]]["name"]); s = re.sub(EDITION_WORDS, " ", s)
    return re.sub(r"\s+", " ", s).strip(), (dc_issues[b]["number"] or "").strip("[]").lstrip("0") or "1"
groups = collections.defaultdict(list)
for b in books: groups[tnorm(b)].append(b)
twin_n = 0
for key, members in groups.items():
    if not key[0]: continue
    mapped = [m for m in members if m in content and any(v[0] in ("gcd_link", "notes") for v in content[m].values())]
    for m in members:
        if m in content or not mapped: continue
        pm = dc_issues[m]["page_count"] or 0
        best = min(mapped, key=lambda x: abs((dc_issues[x]["page_count"] or 0) - pm))
        pb = dc_issues[best]["page_count"] or 0
        if pm and pb and abs(pm - pb) / max(pm, pb) > 0.2: continue
        content[m] = {i: ("twin", p) for i, (s, p) in content[best].items()}; twin_n += 1
log(f"3. twin: {twin_n} books")

# ---------- 4. self (original material) ----------
self_n = 0
for b in books:
    if b in content: continue
    has_story = any(story_type[s] in (19, 21) for s in book_stories.get(b, []))
    collects = re.search(r"\bcollect", dc_issues[b]["notes"], re.I)
    if has_story and not collects:
        content[b] = {b: ("self", 0)}; self_n += 1
log(f"4. self/original: {self_n} books")

# ---------- 5. overrides ----------
ovr_n = 0
if os.path.exists(OVR):
    for row in csv.DictReader(open(OVR, encoding="utf-8")):
        if not row.get("book_id") or row["book_id"].startswith("#"): continue
        b = int(row["book_id"]); sid = int(row["series_id"]); seq = series_issues.get(sid, [])
        ia = find_num(sid, row["number_from"]); ib = find_num(sid, row.get("number_to") or row["number_from"])
        if ia is None or ib is None: print("override not found:", row); continue
        sel = seq[ia:ib + 1]; c = content.setdefault(b, {})
        for i in sel:
            if row["action"] == "remove": c.pop(i, None)
            else: c[i] = ("override", int(row.get("partial") or 0))
        ovr_n += 1
log(f"5. overrides applied: {ovr_n}")

# ---------- normalization ----------
def book_format(s):
    n, b, pf = s["name"].lower(), s["binding"].lower(), s["pf"].lower()
    for key, label in (("omnibus", "Omnibus"), ("compendium", "Compendium"), ("absolute ", "Absolute"), ("deluxe", "Deluxe Edition"),
                       ("dc finest", "DC Finest"), ("compact comics", "Compact"), ("box set", "Box Set"), ("boxed set", "Box Set"),
                       ("library edition", "Library Edition"), ("noir", "Noir Edition"), ("unwrapped", "Unwrapped"), ("showcase presents", "Showcase Presents"),
                       ("archives", "Archive Edition"), ("chronicles", "Chronicles"), ("dc comics classics library", "Classics Library")):
        if key in n: return label
    if "graphic novel" in pf: return "Graphic Novel"
    if "hardcover" in b or "hard cover" in b: return "Hardcover"
    return "Trade Paperback"
def fix_format(s, fmt):
    soft = any(w in s["binding"].lower() for w in ("trade", "softcover", "paperback", "squarebound", "perfect"))
    return "Trade Paperback" if fmt in ("Absolute", "Omnibus") and soft and "hard" not in s["binding"].lower() else fmt
def cover_type(s, fmt):
    b = s["binding"].lower()
    if any(w in b for w in ("hardcover", "hard cover", "slipcase", "dustjacket", "dust jacket", "leather", "casebound")): return "hard"
    if any(w in b for w in ("trade", "softcover", "soft cover", "paperback", "squarebound", "square bound", "perfect", "saddle", "glued", "prestige")): return "soft"
    if fmt in ("Omnibus", "Absolute", "Deluxe Edition", "Archive Edition", "Library Edition", "Noir Edition"): return "hard"
    return None
def periodical_format(s):
    pf = s["pf"].lower()
    if "one-shot" in pf or "one shot" in pf or "giveaway" in pf: return "One-shot"
    if "limited" in pf or "mini" in pf: return "Limited Series"
    if "ongoing" in pf: return "Ongoing Series"
    return "Series"

# ---------- write catalog ----------
if os.path.exists(OUT): os.remove(OUT)
o = sqlite3.connect(OUT)
o.executescript("""
create table series(id integer primary key, name text, sort_name text, year_began int, year_ended int, kind text, format text, cover text, issue_count int);
create table issue(id integer primary key, series_id int, number text, volume text, title text, key_date text, on_sale_date text, page_count real,
  price text, isbn text, barcode text, sort_code int, kind text, format text, cover text, content_source text, content_count int);
create table book_content(book_id int, issue_id int, source text, partial int, primary key(book_id, issue_id)) without rowid;
create table edition_group(book_id integer primary key, group_id int, group_size int);
create table story(id integer primary key, issue_id int, seq int, type text, title text, feature text, page_count real,
  script text, pencils text, inks text, colors text, letters text, editing text, characters text, synopsis text);
create table unresolved_note(book_id int, raw text);
create table meta(key text primary key, value text);
""")
dc_series_ids = {dc_issues[i]["series_id"] for i in dc_issues}
for sid in dc_series_ids:
    s = series[sid]; fmt = fix_format(s, book_format(s)) if s["book"] else periodical_format(s)
    o.execute("insert into series values (?,?,?,?,?,?,?,?,?)", (sid, s["name"], s["sort_name"], s["year_began"], s["year_ended"],
              "book" if s["book"] else "periodical", fmt, cover_type(s, fmt) if s["book"] else "soft", s["issue_count"]))
sfmt = {r[0]: r[1:] for r in o.execute("select id, format, cover from series")}
for i, d in dc_issues.items():
    s = series[d["series_id"]]; c = content.get(i)
    src = None
    if c: src = collections.Counter(v[0] for v in c.values()).most_common(1)[0][0]
    o.execute("insert into issue values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (i, d["series_id"], d["number"], d["volume"], d["title"], d["key_date"],
              d["on_sale_date"], d["page_count"], d["price"], d["isbn"], d["barcode"], d["sort_code"], "book" if s["book"] else "periodical",
              sfmt[d["series_id"]][0], sfmt[d["series_id"]][1], src, len(c) if c else None))
o.executemany("insert into book_content values (?,?,?,?)", [(b, i, s, p) for b, c in content.items() for i, (s, p) in c.items()])
# editions: union books whose original-issue sets overlap >= 85% (Jaccard); single-issue sets need the same normalized title
parent = {}
def find(x):
    while parent.setdefault(x, x) != x: parent[x] = parent[parent[x]]; x = parent[x]
    return x
inv = collections.defaultdict(list)
cands = {b: frozenset(c) for b, c in content.items() if not any(v[0] == "self" for v in c.values())}
for b, cs in cands.items():
    for i in cs: inv[i].append(b)
seen = set()
for b, cs in cands.items():
    pool = collections.Counter(x for i in cs for x in inv[i] if x != b)
    for x, inter in pool.items():
        if (x, b) in seen: continue
        seen.add((b, x)); cx = cands[x]
        j = inter / len(cs | cx)
        same = tnorm(b)[0] == tnorm(x)[0]
        if (j >= 0.85 and (len(cs | cx) >= 3 or same)) or (j >= 0.75 and same): parent[find(b)] = find(x)
clusters = collections.defaultdict(list)
for b in cands: clusters[find(b)].append(b)
gid = 0
for members in clusters.values():
    if len(members) > 1:
        gid += 1; o.executemany("insert into edition_group values (?,?,?)", [(m, gid, len(members)) for m in members])
TYPES = dict(q("select id, name from gcd_story_type"))
o.executemany("insert into story values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  [r[:3] + (TYPES.get(r[3]),) + r[4:] for r in q("""select id, issue_id, sequence_number, type_id, title, feature, page_count, script, pencils, inks, colors, letters, editing, characters, synopsis
     from gcd_story where deleted=0 and type_id in (%s) and issue_id in (select i.id from gcd_issue i join gcd_series s on s.id=i.series_id where s.publisher_id=%d and i.deleted=0 and coalesce(i.variant_of_id,0)=0)""" % (",".join(map(str, CONTENT_TYPES)), DC))])
o.executemany("insert into unresolved_note values (?,?)", unresolved)
o.executemany("insert into meta values (?,?)", [("source", os.path.basename(SRC)), ("built", time.strftime("%Y-%m-%d %H:%M")),
              ("license", "Data from the Grand Comics Database (comics.org), CC BY-SA 4.0")])
o.executescript("""create index ix_issue_series on issue(series_id); create index ix_bc_issue on book_content(issue_id);
  create index ix_story_issue on story(issue_id); create index ix_eg on edition_group(group_id);""")
o.commit()
log(f"edition groups: {gid}")
log("DONE ->", OUT, f"{os.path.getsize(OUT)/1e6:.0f} MB")
