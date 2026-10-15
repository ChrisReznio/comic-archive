import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getContentMap, getIssues, getSeries, getSeriesIssues, search, seriesLabel, type IssueWithSeries, type SearchHit } from "../lib/db";
import { compressRun, groupBySeries, useCoverage } from "../lib/coverage";
import { addToCompare, clearCompare, removeFromCompare, useCompare, type CompareEntry, type CompareSide } from "../lib/user";
import { ErrorBox, Loading, RunBar } from "../components/ui";
import { useCanTrack } from "../lib/supabase";

/** Resolve compare entries into a set of issue ids (partial content tracked separately). */
async function resolveEntries(entries: CompareEntry[]) {
  const full = new Set<number>(), partial = new Set<number>();
  const books = entries.filter((e) => e.type === "book").map((e) => e.id);
  for (const e of entries) {
    if (e.type === "issue") full.add(e.id);
    if (e.type === "series") {
      const s = await getSeries(e.id);
      const issues = await getSeriesIssues(e.id);
      if (s?.kind === "book") books.push(...issues.map((i) => i.id));
      else issues.forEach((i) => full.add(i.id));
    }
  }
  const map = await getContentMap(books);
  for (const rows of map.values()) for (const r of rows) (r.partial ? partial : full).add(r.issue);
  for (const i of full) partial.delete(i);
  return { full, partial };
}

export default function ComparePage() {
  const entries = useCompare();
  const cov = useCoverage();
  const canTrack = useCanTrack();
  const [mineState, setMineAsB] = useState(false);
  const mineAsB = mineState && canTrack;
  const a = entries.filter((e) => e.side === "A");
  const b = entries.filter((e) => e.side === "B");
  const key = entries.map((e) => e.key).join("|") + (mineAsB ? "|mine:" + cov.ownedBooks.size + ":" + cov.ownedIssues.size + ":" + cov.viaBooks.size : "");
  const [state, setState] = useState<{ loading: boolean; error?: Error; res?: Awaited<ReturnType<typeof compute>> }>({ loading: false });

  async function compute() {
    const A = await resolveEntries(a);
    let B: { full: Set<number>; partial: Set<number> };
    if (mineAsB) {
      const full = new Set<number>(cov.ownedIssues), partial = new Set<number>();
      for (const [i, v] of cov.viaBooks) (v.some((x) => !x.partial) ? full : partial).add(i);
      for (const i of full) partial.delete(i);
      B = { full, partial };
    } else B = await resolveEntries(b);
    const relevant = mineAsB ? new Set([...A.full, ...A.partial]) : new Set([...A.full, ...A.partial, ...B.full, ...B.partial]);
    const issues = await getIssues([...relevant]);
    const inA = (i: number) => A.full.has(i) || A.partial.has(i);
    const inB = (i: number) => B.full.has(i) || B.partial.has(i);
    return { A, B, issues, inA, inB };
  }

  useEffect(() => {
    if (!a.length || (!b.length && !mineAsB)) { setState({ loading: false }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    compute().then((res) => alive && setState({ loading: false, res }), (error) => alive && setState({ loading: false, error }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div>
      <h1 className="display">Compare</h1>
      <p className="muted" style={{ margin: "8px 0 20px", maxWidth: "62ch" }}>
        Build two lists of books, issues or whole series and see what they share and what each one adds. Handy for choosing between
        an omnibus and a stack of trades, or for checking what a book would add to your shelf.
      </p>
      <div className="two-col">
        <Side side="A" entries={a} />
        {mineAsB ? (
          <div className="side b">
            <div className="section-head"><h2 className="display">B: your collection</h2>
              <button className="btn small ghost" onClick={() => setMineAsB(false)}>Use a list</button></div>
            <p className="small muted">{cov.ownedBooks.size} books and {cov.ownedIssues.size} single issues.</p>
          </div>
        ) : (
          <Side side="B" entries={b} extra={canTrack ? <button className="btn small ghost" onClick={() => setMineAsB(true)}>Compare with my collection</button> : undefined} />
        )}
      </div>
      <section className="section">
        {state.error && <ErrorBox error={state.error} />}
        {state.loading && <Loading>Comparing…</Loading>}
        {!a.length && <p className="empty">Add something to list A to start. You can also use “Add to A” on any book, issue or series page.</p>}
        {state.res && !state.loading && <Result res={state.res} mineAsB={mineAsB} />}
      </section>
    </div>
  );
}

function Side({ side, entries, extra }: { side: CompareSide; entries: CompareEntry[]; extra?: React.ReactNode }) {
  return (
    <div className={`side ${side === "B" ? "b" : ""}`}>
      <div className="section-head">
        <h2 className="display">List {side}</h2>
        <span className="row" style={{ gap: 4 }}>
          {extra}
          {entries.length > 0 && <button className="btn small ghost" onClick={() => clearCompare(side)}>Clear</button>}
        </span>
      </div>
      <Picker side={side} />
      <div style={{ marginTop: 8 }}>
        {entries.map((e) => (
          <div key={e.key} className="side-entry">
            <span>
              <Link to={e.type === "book" ? `/book/${e.id}` : e.type === "issue" ? `/issue/${e.id}` : `/series/${e.id}`}>{e.label}</Link>{" "}
              <span className="chip">{e.type === "book" ? "book" : e.type === "issue" ? "issue" : "whole series"}</span>
            </span>
            <button className="btn small ghost" aria-label={`Remove ${e.label}`} onClick={() => removeFromCompare(e.key)}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Picker({ side }: { side: CompareSide }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => search(q).then((h) => setHits(h.slice(0, 20))), 180);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const add = async (h: SearchHit) => {
    const label = h.kind === "book" ? h.label : seriesLabel(h.label, h.year ? +h.year : null);
    await addToCompare(side, h.kind === "book" ? "book" : "series", h.ref, label);
    setQ(""); setOpen(false);
  };
  return (
    <div className="picker" ref={box}>
      <input className="input" style={{ width: "100%" }} value={q} placeholder="Add a book or series…" aria-label={`Add to list ${side}`}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && hits.length > 0 && (
        <div className="picker-results" role="listbox">
          {hits.map((h) => (
            <button key={h.kind + h.ref} role="option" aria-selected="false" onClick={() => add(h)}>
              <strong>{h.kind === "book" ? h.label : seriesLabel(h.label, h.year ? +h.year : null)}</strong>{" "}
              <span className="small faint">
                {h.kind === "book" ? h.extra.f : h.extra.k === "book" ? `${h.extra.f}, ${h.extra.n} vol.` : `whole series, ${h.extra.n} issues`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Result({ res, mineAsB }: { res: { issues: IssueWithSeries[]; inA: (i: number) => boolean; inB: (i: number) => boolean; A: { partial: Set<number> }; B: { partial: Set<number> } }; mineAsB: boolean }) {
  const groups = useMemo(() => groupBySeries(res.issues), [res]);
  const totals = useMemo(() => {
    let onlyA = 0, both = 0, onlyB = 0;
    for (const i of res.issues) { const a = res.inA(i.id), b = res.inB(i.id); if (a && b) both++; else if (a) onlyA++; else if (b) onlyB++; }
    return { onlyA, both, onlyB, all: onlyA + both + onlyB };
  }, [res]);
  const nameA = "Only in A", nameB = mineAsB ? "You own (not in A)" : "Only in B", nameBoth = mineAsB ? "In A, already owned" : "In both";
  const pct = (n: number) => `${(100 * n) / Math.max(1, totals.all)}%`;
  return (
    <div>
      <h2 className="display">Result</h2>
      <div className="summary-bar" aria-hidden="true">
        <i style={{ width: pct(totals.onlyA), background: "var(--c)" }} />
        <i style={{ width: pct(totals.both), background: "var(--ink-3)" }} />
        <i style={{ width: pct(totals.onlyB), background: "var(--m)" }} />
      </div>
      <div className="stat-line" style={{ marginTop: 12 }}>
        <div className="stat"><strong style={{ color: "var(--c)" }}>{totals.onlyA}</strong><span className="small muted">{mineAsB ? "new issues A would add" : nameA}</span></div>
        <div className="stat"><strong>{totals.both}</strong><span className="small muted">{nameBoth}</span></div>
        {!mineAsB && <div className="stat"><strong style={{ color: "var(--m)" }}>{totals.onlyB}</strong><span className="small muted">{nameB}</span></div>}
      </div>
      <div className="legend" style={{ marginTop: 16 }}>
        <span><i className="cell a" aria-hidden="true" />{mineAsB ? "New to you" : nameA}</span>
        <span><i className="cell ab" aria-hidden="true" />{nameBoth}</span>
        {!mineAsB && <span><i className="cell b" aria-hidden="true" />{nameB}</span>}
      </div>
      {groups.map((g) => {
        const onlyA = g.items.filter((i) => res.inA(i.id) && !res.inB(i.id));
        const both = g.items.filter((i) => res.inA(i.id) && res.inB(i.id));
        const onlyB = g.items.filter((i) => !res.inA(i.id) && res.inB(i.id));
        return (
          <div key={g.seriesId} className="content-group">
            <h3><Link to={`/series/${g.seriesId}`}>{seriesLabel(g.name, g.year)}</Link> <span className="small faint">{g.items.length} issues</span></h3>
            <div style={{ margin: "8px 0" }}>
              <RunBar issues={g.items} cls={(i) => (res.inA(i.id) && res.inB(i.id) ? "ab" : res.inA(i.id) ? "a" : "b")} />
            </div>
            <dl className="kv small">
              {onlyA.length > 0 && <><dt>{mineAsB ? "New" : nameA}</dt><dd>{compressRun(onlyA)}</dd></>}
              {both.length > 0 && <><dt>{nameBoth}</dt><dd>{compressRun(both)}</dd></>}
              {onlyB.length > 0 && <><dt>{nameB}</dt><dd>{compressRun(onlyB)}</dd></>}
            </dl>
          </div>
        );
      })}
      {(res.A.partial.size > 0 || res.B.partial.size > 0) && (
        <p className="small faint" style={{ marginTop: 12 }}>Includes issues that one of the lists only reprints in part (a backup story, for example).</p>
      )}
    </div>
  );
}
