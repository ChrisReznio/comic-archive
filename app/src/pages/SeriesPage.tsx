import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSeries, getSeriesIssues, year, type Issue, type Series } from "../lib/db";
import { cleanNumber, useCoverage } from "../lib/coverage";
import { BookCard, CompareButtons, ErrorBox, Loading, RunBar, StatusLegend, useAsync } from "../components/ui";
import { setFlagMany } from "../lib/user";

export default function SeriesPage() {
  const id = Number(useParams().id);
  const { data, error, loading } = useAsync(async () => {
    const [s, issues] = await Promise.all([getSeries(id), getSeriesIssues(id)]);
    return { s, issues };
  }, [id]);
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data?.s) return <p className="empty">This series isn’t in the catalog.</p>;
  return data.s.kind === "book" ? <BookSeries s={data.s} issues={data.issues} /> : <Periodical s={data.s} issues={data.issues} />;
}

function Header({ s, sub }: { s: Series; sub: string }) {
  const years = s.year_began ? `${s.year_began}${s.year_ended && s.year_ended !== s.year_began ? `–${s.year_ended}` : s.year_ended ? "" : "–"}` : "";
  return (
    <header>
      <div className="crumbs"><Link to="/">Search</Link> / {s.kind === "book" ? "Books" : "Series"}</div>
      <h1 className="display">{s.name}</h1>
      <p className="muted" style={{ margin: "8px 0 0" }}>{[years, s.format, sub].filter(Boolean).join(", ")}</p>
    </header>
  );
}

function Periodical({ s, issues }: { s: Series; issues: Issue[] }) {
  const cov = useCoverage();
  const [mode, setMode] = useState<"mine" | "collected">("mine");
  const counts = useMemo(() => {
    const c = { owned: 0, book: 0, partial: 0, wish: 0, none: 0, collected: 0 };
    for (const i of issues) { c[cov.status(i.id)]++; if (i.collected_in > 0) c.collected++; }
    return c;
  }, [issues, cov]);
  const have = counts.owned + counts.book;
  const label = `${s.name} (${s.year_began ?? "?"})`;
  const markAll = (value: boolean) =>
    setFlagMany("issue", issues.map((i) => ({ id: i.id, label: `${label} #${cleanNumber(i.number)}`, sub: year(i.key_date) })), "owned", value);

  return (
    <div>
      <Header s={s} sub={`${issues.length} issues`} />
      <section className="section" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
            <button role="tab" aria-selected={mode === "mine"} onClick={() => setMode("mine")}>My collection</button>
            <button role="tab" aria-selected={mode === "collected"} onClick={() => setMode("collected")}>What’s been collected</button>
          </div>
          <span className="small muted">
            {mode === "mine"
              ? `You have ${have} of ${issues.length}${counts.partial ? `, ${counts.partial} partly` : ""}`
              : `${counts.collected} of ${issues.length} reprinted in at least one book`}
          </span>
        </div>
        {mode === "mine" ? (
          <>
            <RunBar issues={issues} cls={(i) => cov.status(i.id)} />
            <StatusLegend />
          </>
        ) : (
          <>
            <RunBar
              issues={issues}
              cls={(i) => ((i as Issue).collected_in > 0 ? "book" : "")}
              label={(i) => `in ${(i as Issue).collected_in} books`}
            />
            <div className="legend">
              <span><i className="cell book" aria-hidden="true" />Reprinted in at least one book</span>
              <span><i className="cell" aria-hidden="true" />Never collected (per GCD)</span>
            </div>
          </>
        )}
        <div className="actions">
          <Link className="btn solid" to={`/plan/${s.id}`}>Plan how to complete it</Link>
          <CompareButtons type="series" id={s.id} label={label} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="display">Issues</h2>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small ghost" onClick={() => markAll(true)}>Mark all as owned</button>
            {counts.owned > 0 && <button className="btn small ghost" onClick={() => markAll(false)}>Unmark all</button>}
          </span>
        </div>
        <ul className="list">
          {issues.map((i) => {
            const st = cov.status(i.id);
            return (
              <li key={i.id} className="issue-row">
                <Link className="num" to={`/issue/${i.id}`}>#{cleanNumber(i.number)}</Link>
                <span>
                  <span className={`dot ${st}`} aria-hidden="true" />{" "}
                  <span className="small faint">{i.key_date?.slice(0, 7).replace("-00", "")}</span>
                  {i.title && <> <Link to={`/issue/${i.id}`}>{i.title}</Link></>}
                </span>
                <span className="small faint">{i.collected_in ? `in ${i.collected_in} ${i.collected_in === 1 ? "book" : "books"}` : "not collected"}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function BookSeries({ s, issues }: { s: Series; issues: Issue[] }) {
  return (
    <div>
      <Header s={s} sub={issues.length > 1 ? `${issues.length} volumes` : ""} />
      <section className="section">
        <div className="grid-books">
          {issues.map((i) => (
            <BookCard
              key={i.id}
              id={i.id}
              title={i.title || (issues.length > 1 ? `${s.name} Vol. ${cleanNumber(i.number)}` : s.name)}
              number={issues.length > 1 ? i.number : undefined}
              format={i.format}
              cover={i.cover}
              sub={year(i.key_date)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
