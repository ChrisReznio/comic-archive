import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { bookTitle, getPlanBooks, getSeries, getSeriesIssues, year, type Issue, type PlanBookRow } from "../lib/db";
import { cleanNumber, compressRun, planRun, useCoverage, type PlanBook } from "../lib/coverage";
import { Cover, ErrorBox, FormatChips, Loading, RunBar, useAsync } from "../components/ui";
import { setFlagMany } from "../lib/user";
import { useCanTrack } from "../lib/supabase";

type Pref = "any" | "soft" | "hard" | "big";
const PREF_LABEL: Record<Pref, string> = {
  any: "Fewest books",
  soft: "Prefer paperbacks",
  hard: "Prefer hardcovers",
  big: "Prefer omnibuses and big editions",
};

function cost(b: PlanBookRow, pref: Pref, size: number) {
  let c = 1;
  if (pref === "soft") c *= b.cover === "soft" ? 0.7 : 1.3;
  if (pref === "hard") c *= b.cover === "hard" ? 0.7 : 1.3;
  if (pref === "big") c *= ["Omnibus", "Absolute", "Compendium", "DC Finest"].includes(b.format) || size >= 20 ? 0.5 : 1.2;
  // small nudge to newer printings (easier to buy) unless asking for big editions
  const y = +year(b.key_date) || 2000;
  return c * (1 + (2030 - y) / 400);
}

export default function PlanPage() {
  const id = Number(useParams().id);
  const cov = useCoverage();
  const { data, error, loading } = useAsync(async () => {
    const [s, issues, books] = await Promise.all([getSeries(id), getSeriesIssues(id), getPlanBooks(id)]);
    return { s, issues, books };
  }, [id]);

  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(-1);
  const canTrack = useCanTrack();
  const [skipState, setSkipOwned] = useState(true);
  const skipOwned = skipState && canTrack;
  const [pref, setPref] = useState<Pref>("any");

  const plan = useMemo(() => {
    if (!data) return null;
    const last = to < 0 ? data.issues.length - 1 : to;
    const range = data.issues.slice(Math.min(from, last), Math.max(from, last) + 1);
    const have = (i: number) => cov.status(i) === "owned" || cov.status(i) === "book";
    const target = range.filter((i) => !(skipOwned && have(i.id))).map((i) => i.id);
    const bookInfo = new Map(data.books.map((b) => [b.id, b]));
    const candidates: PlanBook[] = [];
    for (const b of data.books) {
      if (skipOwned && cov.ownedBooks.has(b.id)) continue;
      candidates.push({ id: b.id, issues: new Set(b.issues), partial: new Set(b.partial), cost: cost(b, pref, b.total) });
    }
    const result = planRun(target, candidates);
    const planned = new Set(result.picks.flatMap((p) => p.adds));
    return { range, target, result, planned, bookInfo, have };
  }, [data, from, to, skipOwned, pref, cov]);

  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading>Finding every book that reprints this series…</Loading>;
  if (!data?.s || !plan) return <p className="empty">This series isn’t in the catalog.</p>;
  const { s, issues } = data;
  const lastIdx = to < 0 ? issues.length - 1 : to;
  const opt = (i: Issue, k: number) => <option key={i.id} value={k}>#{cleanNumber(i.number)}</option>;
  const wishAll = () =>
    setFlagMany("book", plan.result.picks.map((p) => {
      const b = plan.bookInfo.get(p.book)!;
      return { id: b.id, label: bookTitle(b), sub: `${b.format}, ${year(b.key_date)}` };
    }), "wish", true);

  return (
    <div>
      <div className="crumbs"><Link to={`/series/${s.id}`}>{s.name} ({s.year_began})</Link> / Plan</div>
      <h1 className="display">Complete {s.name}</h1>
      <p className="muted" style={{ margin: "8px 0 0", maxWidth: "62ch" }}>
        Pick the stretch of the run you want and get the combination of books that covers it with the fewest purchases. Anything
        no book reprints is flagged so you can hunt down the single issue.
      </p>
      <div className="toolbar">
        <label>From<select className="input" value={from} onChange={(e) => setFrom(+e.target.value)}>{issues.map(opt)}</select></label>
        <label>To<select className="input" value={lastIdx} onChange={(e) => setTo(+e.target.value)}>{issues.map(opt)}</select></label>
        <label>Strategy
          <select className="input" value={pref} onChange={(e) => setPref(e.target.value as Pref)}>
            {(Object.keys(PREF_LABEL) as Pref[]).map((p) => <option key={p} value={p}>{PREF_LABEL[p]}</option>)}
          </select>
        </label>
        {canTrack && <label style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 8 }}>
          <input type="checkbox" checked={skipOwned} onChange={(e) => setSkipOwned(e.target.checked)} /> Skip what I own
        </label>}
      </div>

      <RunBar
        issues={plan.range}
        cls={(i) => (skipOwned && plan.have(i.id) ? "owned" : plan.planned.has(i.id) ? "book" : "gap")}
      />
      <div className="legend">
        {skipOwned && <span><i className="cell owned" aria-hidden="true" />Already owned</span>}
        <span><i className="cell book" aria-hidden="true" />Covered by the plan</span>
        <span><i className="cell gap" aria-hidden="true" />Not in any book</span>
      </div>

      <div className="stat-line section" style={{ marginTop: 24 }}>
        <div className="stat"><strong>{plan.result.picks.length}</strong><span className="small muted">books to get</span></div>
        <div className="stat"><strong>{plan.planned.size}</strong><span className="small muted">issues they cover</span></div>
        <div className="stat"><strong>{plan.result.uncovered.length}</strong><span className="small muted">left as single issues</span></div>
      </div>
      {plan.target.length === 0 && <p className="empty">You already own this whole stretch.</p>}

      {plan.result.picks.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="display">Suggested books</h2>
            {canTrack && <button className="btn small" onClick={wishAll}>Add all to wishlist</button>}
          </div>
          {plan.result.picks.map((p, k) => {
            const b = plan.bookInfo.get(p.book)!;
            const adds = issues.filter((i) => p.adds.includes(i.id));
            const extra = b.total - b.issues.length;
            return (
              <div key={p.book} className="pick">
                <Link to={`/book/${b.id}`} aria-label={bookTitle(b)}>
                  <Cover id={b.id} kind="book" format={b.format} title={b.title || b.series_name} number={b.number} />
                </Link>
                <div>
                  <div className="small faint">Book {k + 1}</div>
                  <Link to={`/book/${b.id}`} style={{ fontWeight: 700 }}>{bookTitle(b)}</Link> <span className="small faint">{year(b.key_date)}</span>
                  <div style={{ margin: "4px 0" }}><FormatChips format={b.format} cover={b.cover} /></div>
                  <div className="small">Adds {compressRun(adds)} ({adds.length} issues)</div>
                  {extra > 0 && <div className="small faint">Also includes {extra} issues from other series</div>}
                </div>
              </div>
            );
          })}
        </section>
      )}
      {plan.result.uncovered.length > 0 && (
        <section className="section">
          <h2 className="display" style={{ marginBottom: 8 }}>Get as single issues</h2>
          <p className="muted">{compressRun(issues.filter((i) => plan.result.uncovered.includes(i.id)))}</p>
        </section>
      )}
    </div>
  );
}
