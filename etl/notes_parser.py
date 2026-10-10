"""Parse GCD 'Collects ...' notes into (series_name, year, numbers, partial) references."""
import re

STOP = re.compile(r"\n\s*\n|(?:^|[.\n]\s*)Stories (?:from|originally)|On sale date|This (?:Barnes|edition|collection|volume)|Also includes|Includes |Plus |Bonus ")
SERIES_YEAR = re.compile(r"^(?P<name>.+?)\s*\{\{(?P<year>\d{4})\}\}\s*(?P<rest>.*)$", re.S)
PAREN = re.compile(r"\((?:[^,()]*,\s*)?(\d{4})\s*series\)")
NUMS = re.compile(r"#\s*([\w.½/]+)(?:\s*[-–]\s*#?\s*([\w.½/]+))?")

def clean(s):
    return re.sub(r"\s+", " ", s.replace("\r", " ")).strip(" .:;\t")

def split_entries(text):
    text = PAREN.sub(lambda m: "{{%s}}" % m.group(1), text)
    text = re.sub(r"\s*\n\s*", ", ", text)
    # split on commas / ' and ' that start a new entry (not those inside a number list)
    out = []
    for chunk in re.split(r",\s*(?:and\s+)?", text):
        # ' and ' starts a new entry only when the left side is already a complete reference
        pieces = re.split(r"\s+and\s+", chunk); acc = pieces[0]
        for nxt in pieces[1:]:
            if re.search(r"#\s*[\w.]+\s*$|\}\}\s*$", acc): out.append(acc); acc = nxt
            else: acc = acc + " and " + nxt
        out.append(acc)
    return [p for p in (clean(x) for x in out) if p]

def parse_collects(notes):
    if not notes: return []
    m = re.search(r"\bcollect(?:s|ing|ed)?\b[:\s]*", notes, re.I)
    if not m: return []
    body = notes[m.end():]
    s = STOP.search(body)
    if s: body = body[:s.start()]
    refs, cur, cur_partial = [], None, False
    # "Collects Robin's major solo appearances from: ..." -> everything listed is only partly reprinted
    lead = re.match(r"^[^#{}\n]*?\b(?:appearances|stories|story|backups?|back-ups?|features?|tales|material|segments?|chapters?)\b[^#{}\n]*?\bfrom\b\s*:?", body, re.I)
    all_partial = False
    if lead and not re.search(r"\(\s*(?:DC[^,)]*,\s*)?\d{4}\s*series\)", lead.group(0)):
        all_partial = True; body = body[lead.end():]
    for ent in split_entries(body):
        partial = bool(re.match(r"(?:a |the )?(?:\w+ )*(?:stor(?:y|ies)|feature|backups?|back-ups?|segments?|pages?)\s+(?:from|in)\s+", ent, re.I))
        ent2 = re.sub(r"^(?:a |the )?(?:[\w\-']+ )*?(?:stor(?:y|ies)|feature|backups?|back-ups?|segments?|pages?)\s+(?:from|in)\s+", "", ent, flags=re.I) if partial else ent
        ent2 = re.sub(r"^(?:material|issues?|portions?)\s+(?:from|of)\s+", "", ent2, flags=re.I)
        name, year = None, None
        sy = SERIES_YEAR.match(ent2)
        if sy:
            name, year, rest = clean(sy.group("name")), int(sy.group("year")), sy.group("rest")
        else:
            i = ent2.find("#")
            if i > 0: name, rest = clean(ent2[:i]), ent2[i:]
            elif i == 0:  # continuation like '#663-669' -> previous series, same partial flag
                rest = ent2; partial = partial or cur_partial
            else:
                name, rest = clean(ent2), ""  # one-shot without number
        if name:
            cur = (name, year); cur_partial = partial
        if cur is None: continue
        nums = NUMS.findall(rest)
        refs.append({"name": cur[0], "year": cur[1], "ranges": nums or [("", "")], "partial": partial or all_partial, "raw": ent})
    return refs

if __name__ == "__main__":
    import sys, json
    for t in sys.argv[1:]: print(json.dumps(parse_collects(t), indent=1))
