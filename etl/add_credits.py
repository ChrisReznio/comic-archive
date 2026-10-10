"""Fill story credit columns (script, pencils, inks, colors, letters, editing) in catalog.sqlite from GCD credit tables.

Usage: python3 -I add_credits.py credits.sqlite catalog.sqlite
"""
import collections, re, sqlite3, sys, time
t0 = time.time()
cat = sqlite3.connect(sys.argv[2]); cat.execute(f"attach '{sys.argv[1]}' as cr")
types = dict(cat.execute("select id, name from cr.gcd_credit_type").fetchall())
print("credit types:", types)
COL = {"script": "script", "pencils": "pencils", "inks": "inks", "colors": "colors", "letters": "letters", "editing": "editing",
       "painting": "pencils", "pencils and inks": "pencils", "pencils and inks and colors": "pencils"}
cat.execute("create temp table ids as select id from story"); cat.execute("create index temp.ix_ids on ids(id)")
rows = cat.execute("""select c.story_id, c.credit_type_id, n.name, c.uncertain, c.credited_as
  from cr.gcd_story_credit c join cr.gcd_creator_name_detail n on n.id=c.creator_id
  where c.deleted=0 and c.story_id in (select id from ids) order by c.story_id, c.id""").fetchall()
print(len(rows), "credits for DC stories", round(time.time() - t0), "s")
agg = collections.defaultdict(lambda: collections.defaultdict(list))
for sid, tid, name, unc, cas in rows:
    tname = (types.get(tid) or "").lower().replace("painting", "pencils")
    label = name + ("?" if unc else "")
    for role in re.split(r",\s*and\s+|,\s*|\s+and\s+", tname):
        col = role.strip()
        if col in ("script", "pencils", "inks", "colors", "letters", "editing") and label not in agg[sid][col]:
            agg[sid][col].append(label)
cols = ["script", "pencils", "inks", "colors", "letters", "editing"]
cat.executemany(f"update story set {', '.join(c + '=?' for c in cols)} where id=?",
                [tuple("; ".join(a.get(c, [])) for c in cols) + (sid,) for sid, a in agg.items()])
cat.commit()
print("stories with credits:", len(agg), "| done", round(time.time() - t0), "s")
print(cat.execute("select title, script, pencils, inks from story where issue_id in (select i.id from issue i join series s on s.id=i.series_id where s.name='Batman' and s.year_began=1940 and i.number='404')").fetchall())
