"""Build the browser database (read over HTTP range requests with sql.js-httpvfs) from catalog.sqlite.

Usage: python3 build_app_db.py catalog.sqlite OUT_DIR [chunk_mb] [--keep-full]
Writes OUT_DIR/db/config.json + OUT_DIR/db/app.sqlite.000, .001 ... (chunked so any static host works).
Tables are created WITHOUT ROWID and clustered by the key each screen queries, so a page view touches few DB pages.
"""
import json, os, re, sqlite3, sys, unicodedata

src, out_dir = sys.argv[1], sys.argv[2]
chunk = int(float(sys.argv[3]) * 1024 * 1024) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else 8 * 1024 * 1024
os.makedirs(os.path.join(out_dir, "db"), exist_ok=True)
tmp = os.path.join(out_dir, "db", "app.sqlite.tmp")
if os.path.exists(tmp): os.remove(tmp)
db = sqlite3.connect(tmp)
db.execute("pragma page_size=4096"); db.execute("pragma journal_mode=delete")
db.execute(f"attach '{src}' as c")

def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()
db.create_function("fold", 1, fold)

db.executescript("""
-- issues per series in reading order (series page = one range scan)
create table issue(
  series_id int, sort_code int, id int, number text, title text, key_date text, on_sale_date text, page_count real,
  price text, isbn text, kind text, format text, cover text, content_count int, collected_in int,
  primary key(series_id, sort_code, id)) without rowid;
create table issue_by_id(id integer primary key, series_id int, sort_code int);
create table series(id integer primary key, name text, sort_name text, year_began int, year_ended int, kind text,
  format text, cover text, n_issues int, first_issue int);
create table book_content(book_id int, issue_id int, partial int, source text, primary key(book_id, issue_id)) without rowid;
create table content_by_issue(issue_id int, book_id int, partial int, primary key(issue_id, book_id)) without rowid;
create table edition(group_id int, book_id int, primary key(group_id, book_id)) without rowid;
create table edition_by_book(book_id integer primary key, group_id int);
create table story(issue_id int, seq int, type text, title text, feature text, page_count real,
  script text, pencils text, inks text, colors text, letters text, characters text, synopsis text,
  primary key(issue_id, seq, type, title)) without rowid;
create table meta(key text primary key, value text);
""")
db.executescript("""
insert into issue select i.series_id, coalesce(i.sort_code,0), i.id, i.number, i.title, i.key_date, i.on_sale_date, i.page_count, i.price, i.isbn,
  i.kind, i.format, i.cover, i.content_count, (select count(*) from c.book_content b where b.issue_id=i.id)
  from c.issue i order by i.series_id, i.sort_code, i.id;
insert into issue_by_id select id, series_id, sort_code from issue;
insert into series select s.id, s.name, s.sort_name, s.year_began, s.year_ended, s.kind, s.format, s.cover,
  (select count(*) from issue i where i.series_id=s.id), (select i.id from issue i where i.series_id=s.id order by sort_code limit 1)
  from c.series s;
insert into book_content select book_id, issue_id, partial, source from c.book_content order by book_id, issue_id;
insert into content_by_issue select issue_id, book_id, partial from c.book_content where source<>'self' order by issue_id, book_id;
insert into edition select group_id, book_id from c.edition_group order by group_id, book_id;
insert into edition_by_book select book_id, group_id from c.edition_group;
insert or ignore into story select issue_id, coalesce(seq,0), type, coalesce(title,''), feature, page_count, script, pencils, inks, colors, letters,
  characters, synopsis from c.story order by issue_id, seq;
insert into meta select * from c.meta;
-- run planner: for each periodical series, every book that reprints any of its issues, with the ids it covers in that series
create table plan_book(series_id int, book_id int, key_date text, format text, cover text, number text, title text,
  series_name text, series_year int, total int, issues text, partial text, primary key(series_id, book_id)) without rowid;
insert into plan_book
  select oi.series_id, bc.book_id, bi.key_date, bi.format, bi.cover, bi.number, bi.title, bs.name, bs.year_began,
    (select count(*) from c.book_content x where x.book_id=bc.book_id),
    json_group_array(bc.issue_id), json_group_array(case when bc.partial then bc.issue_id end)
  from c.book_content bc join c.issue oi on oi.id=bc.issue_id join c.issue bi on bi.id=bc.book_id join c.series bs on bs.id=bi.series_id
  where bc.source<>'self' and oi.kind='periodical'
  group by oi.series_id, bc.book_id order by oi.series_id, bc.book_id;
""")
# full-text search over series names and book volume titles
db.executescript("""
create virtual table search using fts5(label unindexed, alt, kind unindexed, ref unindexed, year unindexed, extra unindexed,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3');
""")
rows = []
for sid, name, yb, kind, fmt, n in db.execute("select id, name, year_began, kind, format, n_issues from series"):
    rows.append((name, fold(name), "series", sid, yb, json.dumps({"k": kind, "f": fmt, "n": n})))
for iid, sname, num, title, fmt, yb, sid in db.execute("""select i.id, s.name, i.number, i.title, i.format, substr(i.key_date,1,4), s.id
      from issue i join series s on s.id=i.series_id where i.kind='book' and coalesce(i.title,'')<>''"""):
    rows.append((f"{sname}: {title}", fold(f"{sname} {title}"), "book", iid, yb, json.dumps({"f": fmt, "num": num, "s": sid})))
db.executemany("insert into search(label, alt, kind, ref, year, extra) values (?,?,?,?,?,?)", rows)
db.execute("insert into search(search) values('optimize')")
db.execute("create index ix_series_name on series(sort_name)")
db.execute("insert or replace into meta values ('built_app', datetime('now'))")
db.commit()
db.execute("detach c"); db.execute("vacuum"); db.close()
print("search rows:", len(rows))

# split into chunks for static hosting
size = os.path.getsize(tmp)
for f in os.listdir(os.path.join(out_dir, "db")):
    if f.startswith("app.sqlite.") and f != "app.sqlite.tmp": os.remove(os.path.join(out_dir, "db", f))
with open(tmp, "rb") as f:
    i = 0
    while True:
        b = f.read(chunk)
        if not b: break
        open(os.path.join(out_dir, "db", f"app.sqlite.{i:03d}"), "wb").write(b); i += 1
import hashlib, time
bust = time.strftime("%Y%m%d%H%M%S")
json.dump({"serverMode": "chunked", "requestChunkSize": 4096, "cacheBust": bust, "databaseLengthBytes": size, "serverChunkSize": chunk,
           "urlPrefix": "app.sqlite.", "suffixLength": 3, "chunks": i},
          open(os.path.join(out_dir, "db", "config.json"), "w"))
if "--keep-full" in sys.argv: os.replace(tmp, os.path.join(out_dir, "app.sqlite"))
else: os.remove(tmp)
print(f"app db {size/1e6:.1f} MB in {i} chunks")
