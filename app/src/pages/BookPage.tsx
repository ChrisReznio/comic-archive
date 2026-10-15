import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { bookTitle, getBookContent, getContentMap, getEditions, getIssue, getStories, year, type ContentRow } from "../lib/db";
import { cleanNumber, compressRun, groupBySeries, useCoverage } from "../lib/coverage";
import { CompareButtons, Cover, Crumbs, ErrorBox, FormatChips, Loading, OwnButtons, useAsync } from "../components/ui";
import { StoryRow } from "./IssuePage";

const SOURCE_NOTE: Record<string, string> = {
  gcd_link: "Contents from GCD’s reprint links.",
  notes: "Contents parsed from the book’s description on GCD. May contain small errors.",
  twin: "Contents copied from another edition with the same title and page count. Worth double-checking.",
  override: "Contents corrected by hand.",
  self: "Original material: this book doesn’t reprint any issues.",
};

export default function BookPage() {
  const id = Number(useParams().id);
  const cov = useCoverage();
  const { data, error, loading } = useAsync(async () => {
    const book = await getIssue(id);
    if (!book) return null;
    const [content, editions, stories] = await Promise.all([getBookContent(id), getEditions(id), getStories(id)]);
    const edMap = await getContentMap(editions.map((e) => e.id));
    return { book, content, editions, stories, edMap };
  }, [id]);

  const derived = useMemo(() => {
    if (!data) return null;
    const issues = data.content.filter((c) => c.source !== "self");
    const groups = groupBySeries(issues);
    // what the user already has from this book, not counting this book itself
    const haveElsewhere = issues.filter((c) => cov.ownedIssues.has(c.id) || (cov.viaBooks.get(c.id) ?? []).some((v) => v.book !== id && !v.partial));
    const sources = [...new Set(data.content.map((c) => c.source))];
    const mine = new Set(issues.map((c) => c.id));
    const editions = data.editions
      .filter((e) => e.id !== id)
      .map((e) => {
        const other = new Set((data.edMap.get(e.id) ?? []).map((r) => r.issue));
        return { e, plus: [...other].filter((x) => !mine.has(x)).length, minus: [...mine].filter((x) => !other.has(x)).length };
      });
    const readCount = issues.filter((c) => cov.isRead(c.id)).length;
    return { issues, groups, haveElsewhere, sources, editions, readCount };
  }, [data, cov, id]);

  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Loading />;
  if (!data || !derived) return <p className="empty">This book isn’t in the catalog.</p>;
  const { book } = data;
  if (book.kind !== "book") return <p className="empty">This is a single issue. <Link to={`/issue/${book.id}`}>Open its page</Link>.</p>;
  const title = bookTitle(book);
  const isSelf = derived.sources.includes("self");

  return (
    <>
      <Crumbs items={[{ label: book.series_name, to: `/series/${book.series_id}` }, { label: book.number && book.number !== "[nn]" ? `Vol. ${book.number.replace(/^\[|\]$/g, "")}` : year(book.key_date) || "Book" }]} />
    <div className="detail">
      <div className="detail-cover">
        <Cover id={book.id} kind="book" format={book.format} title={book.title || book.series_name} number={book.number} />
      </div>
      <div>
        <h1 className="display">{title}</h1>
        <div className="row" style={{ marginTop: 12 }}><FormatChips format={book.format} cover={book.cover} /></div>
        <dl className="kv" style={{ marginTop: 16 }}>
          {year(book.key_date) && <><dt>Published</dt><dd>{book.on_sale_date || book.key_date.replace(/-00/g, "")}</dd></>}
          {book.page_count ? <><dt>Pages</dt><dd>{book.page_count}</dd></> : null}
          {book.isbn && <><dt>ISBN</dt><dd>{book.isbn}</dd></>}
          {book.price && <><dt>Price</dt><dd>{book.price}</dd></>}
        </dl>
        <div className="actions">
          <OwnButtons type="book" id={book.id} label={title} sub={`${book.format}, ${year(book.key_date)}`} />
        </div>
        <CompareButtons type="book" id={book.id} label={title} />

        <section className="section">
          <div className="section-head">
            <h2 className="display">What’s inside</h2>
            {!isSelf && derived.issues.length > 0 && (
              <span className="small muted">
                {derived.issues.length} issues from {derived.groups.length} series
                {derived.haveElsewhere.length > 0 && `. You already own ${derived.haveElsewhere.length} elsewhere`}
                {derived.readCount > 0 && !cov.readBooks.has(id) && `. You’ve read ${derived.readCount}`}
              </span>
            )}
          </div>
          {derived.sources.filter((s) => SOURCE_NOTE[s]).map((s) => <p key={s} className="small faint" style={{ margin: "0 0 10px" }}>{SOURCE_NOTE[s]}</p>)}
          {!derived.sources.length && (
            <p className="empty">We don’t know what this book contains yet: GCD hasn’t indexed it.</p>
          )}
          {derived.groups.map((g) => <ContentGroup key={g.seriesId} g={g} />)}
        </section>

        {derived.editions.length > 0 && (
          <section className="section">
            <h2 className="display" style={{ marginBottom: 8 }}>Other editions</h2>
            <ul className="list">
              {derived.editions.map(({ e, plus, minus }) => (
                <li key={e.id} className="hit" style={{ display: "grid" }}>
                  <span><Link to={`/book/${e.id}`} className="hit-name">{bookTitle(e)}</Link> <span className="small faint">{year(e.key_date)}</span></span>
                  <FormatChips format={e.format} cover={e.cover} />
                  <span className="hit-meta">
                    {plus === 0 && minus === 0 ? "Same contents" : [plus && `${plus} more ${plus === 1 ? "issue" : "issues"}`, minus && `${minus} fewer`].filter(Boolean).join(", ")}
                    {e.page_count ? `. ${e.page_count} pages` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.stories.length > 0 && (isSelf || data.stories.some((s) => s.type !== "comic story")) && (
          <section className="section">
            <h2 className="display" style={{ marginBottom: 8 }}>Table of contents</h2>
            {data.stories.map((s) => <StoryRow key={`${s.seq}-${s.title}`} s={s} />)}
          </section>
        )}
      </div>
    </div>
    </>
  );
}

function ContentGroup({ g }: { g: { seriesId: number; name: string; year: number | null; items: ContentRow[] } }) {
  const cov = useCoverage();
  return (
    <div className="content-group">
      <h3><Link to={`/series/${g.seriesId}`}>{g.name}{g.year ? ` (${g.year})` : ""}</Link></h3>
      <div className="run">{compressRun(g.items)}</div>
      <div className="issue-pills">
        {g.items.map((c) => (
          <Link key={c.id} to={`/issue/${c.id}`} className={`pill ${cov.status(c.id)}`} title={c.partial ? "Only part of this issue" : undefined}>
            {cleanNumber(c.number)}{c.partial ? "½" : ""}
          </Link>
        ))}
      </div>
    </div>
  );
}
