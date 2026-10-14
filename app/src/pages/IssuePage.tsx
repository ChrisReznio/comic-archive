import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { bookTitle, getCollectedIn, getIssue, getSeriesIssues, getStories, issueLabel, year, type Story } from "../lib/db";
import { cleanNumber, STATUS_LABEL, useCoverage } from "../lib/coverage";
import { BookCard, CompareButtons, Cover, ErrorBox, Loading, OwnButtons, useAsync } from "../components/ui";

export default function IssuePage() {
  const id = Number(useParams().id);
  const cov = useCoverage();
  const { data, error, loading } = useAsync(async () => {
    const issue = await getIssue(id);
    if (!issue) return null;
    const [stories, books, siblings] = await Promise.all([getStories(id), getCollectedIn(id), getSeriesIssues(issue.series_id)]);
    return { issue, stories, books, siblings };
  }, [id]);

  const groups = useMemo(() => {
    const books = data?.books ?? [];
    const m = new Map<string, typeof books>();
    for (const b of books) {
      const k = b.group_id ? `g${b.group_id}` : `b${b.id}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return [...m.values()];
  }, [data]);

  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data) return <p className="empty">This issue isn’t in the catalog.</p>;
  const { issue, stories, siblings } = data;
  if (issue.kind === "book") return <p className="empty">This is a book. <Link to={`/book/${issue.id}`}>Open the book page</Link>.</p>;

  const idx = siblings.findIndex((s) => s.id === issue.id);
  const prev = siblings[idx - 1], next = siblings[idx + 1];
  const st = cov.status(issue.id);
  const via = cov.viaBooks.get(issue.id) ?? [];
  const label = issueLabel(issue);
  const viaNames = via.map((v) => data.books.find((b) => b.id === v.book)).filter(Boolean);

  return (
    <div className="detail">
      <div className="detail-cover">
        <Cover id={issue.id} kind="periodical" format={issue.format} title={issue.series_name} number={issue.number} />
      </div>
      <div>
        <div className="crumbs">
          <Link to={`/series/${issue.series_id}`}>{issue.series_name} ({issue.series_year})</Link>
        </div>
        <h1 className="display">{issue.series_name} #{cleanNumber(issue.number)}</h1>
        {issue.title && <p className="muted" style={{ fontSize: "var(--step-1)", margin: "6px 0 0" }}>{issue.title}</p>}
        <dl className="kv" style={{ marginTop: 16 }}>
          {issue.key_date && <><dt>Cover date</dt><dd>{issue.key_date.replace(/-00$/, "").replace(/-00-00$/, "")}</dd></>}
          {issue.on_sale_date && <><dt>On sale</dt><dd>{issue.on_sale_date}</dd></>}
          {issue.page_count ? <><dt>Pages</dt><dd>{issue.page_count}</dd></> : null}
          {issue.price && <><dt>Price</dt><dd>{issue.price}</dd></>}
          <dt>Status</dt>
          <dd>
            <span className={`dot ${st}`} aria-hidden="true" /> {STATUS_LABEL[st]}
            {viaNames.length > 0 && (
              <> via {viaNames.map((b, k) => <span key={b!.id}>{k > 0 && ", "}<Link to={`/book/${b!.id}`}>{bookTitle(b!)}</Link></span>)}</>
            )}
          </dd>
          {cov.isRead(issue.id) && <><dt>Read</dt><dd>{cov.readIssues.has(issue.id) ? "Yes" : "Yes, in a book you’ve read"}</dd></>}
        </dl>
        <div className="actions">
          <OwnButtons type="issue" id={issue.id} label={label} sub={year(issue.key_date)} />
        </div>
        <CompareButtons type="issue" id={issue.id} label={label} />
        <div className="row" style={{ marginTop: 16 }}>
          {prev && <Link className="btn small" to={`/issue/${prev.id}`}>‹ #{cleanNumber(prev.number)}</Link>}
          {next && <Link className="btn small" to={`/issue/${next.id}`}>#{cleanNumber(next.number)} ›</Link>}
        </div>

        <section className="section">
          <div className="section-head">
            <h2 className="display">Collected in</h2>
            <span className="small muted">
              {data.books.length ? `${data.books.length} ${data.books.length === 1 ? "book" : "books"}, ${groups.length} ${groups.length === 1 ? "distinct work" : "distinct works"}` : ""}
            </span>
          </div>
          {!data.books.length && <p className="empty">According to GCD, this issue has never been reprinted in a DC book.</p>}
          <div className="stack" style={{ gap: 28 }}>
            {groups.map((g) => (
              <div key={g[0].id}>
                {g.length > 1 && <p className="small muted" style={{ margin: "0 0 8px" }}>{g.length} editions with the same contents</p>}
                <div className="grid-books">
                  {g.map((b) => (
                    <BookCard key={b.id} id={b.id} title={bookTitle(b)} format={b.format} cover={b.cover}
                      sub={b.partial ? "partial" : year(b.key_date)} number={b.number} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {stories.length > 0 && (
          <section className="section">
            <h2 className="display" style={{ marginBottom: 8 }}>Contents</h2>
            {stories.map((s) => <StoryRow key={`${s.seq}-${s.title}`} s={s} />)}
          </section>
        )}
      </div>
    </div>
  );
}

export function StoryRow({ s }: { s: Story }) {
  const credits = [
    s.script && `Script: ${s.script}`,
    s.pencils && `Pencils: ${s.pencils}`,
    s.inks && s.inks !== s.pencils && `Inks: ${s.inks}`,
    s.colors && `Colors: ${s.colors}`,
    s.letters && `Letters: ${s.letters}`,
  ].filter(Boolean);
  return (
    <div className="story">
      <div className="story-title">
        {s.title || <span className="faint">Untitled</span>}{" "}
        <span className="chip">{s.type}</span>
        {s.page_count ? <span className="small faint"> {s.page_count} pp.</span> : null}
      </div>
      {s.feature && <div className="small faint">{s.feature}</div>}
      {credits.length > 0 && <div className="story-credits">{credits.join(". ")}</div>}
      {s.synopsis && <div className="story-syn">{s.synopsis}</div>}
    </div>
  );
}
