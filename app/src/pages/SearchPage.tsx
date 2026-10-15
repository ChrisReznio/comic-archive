import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { search, seriesLabel, type SearchHit } from "../lib/db";
import { ErrorBox, Loading, rememberSearch } from "../components/ui";
import { useCoverage } from "../lib/coverage";

const EXAMPLES = ["Batman 1940", "Watchmen", "Grant Morrison Omnibus", "Absolute Batman", "Sandman", "Green Lantern 2005"];

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export default function SearchPage() {
  const [params] = useSearchParams();
  const q = useDebounced((params.get("q") ?? "").trim(), 180);
  const [state, setState] = useState<{ hits?: SearchHit[]; error?: Error; loading: boolean }>({ loading: false });

  useEffect(() => {
    if (!q) { setState({ loading: false }); return; }
    rememberSearch(q);
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    search(q).then((hits) => alive && setState({ hits, loading: false }), (error) => alive && setState({ error, loading: false }));
    return () => { alive = false; };
  }, [q]);

  if (!q) return <Home />;
  if (state.error) return <ErrorBox error={state.error} />;
  const hits = state.hits ?? [];
  const periodicals = hits.filter((h) => h.kind === "series" && h.extra.k === "periodical");
  const books = hits.filter((h) => !(h.kind === "series" && h.extra.k === "periodical"));
  return (
    <div>
      <h1 className="display" style={{ fontSize: "var(--step-3)" }}>“{q}”</h1>
      {state.loading && !state.hits && <Loading>Searching…</Loading>}
      {state.hits && !hits.length && (
        <p className="empty">Nothing matches “{q}”. Try fewer words or just the series name, like “Detective Comics”.</p>
      )}
      <div className="two-col" style={{ marginTop: 20 }}>
        {periodicals.length > 0 && (
          <section>
            <h2 className="display" style={{ marginBottom: 8 }}>Series</h2>
            <ul className="list">
              {periodicals.map((h) => (
                <li key={h.kind + h.ref}>
                  <Link to={`/series/${h.ref}`} className="hit">
                    <span className="hit-name">{seriesLabel(h.label, h.year ? +h.year : null)}</span>
                    <span className="small faint">{h.extra.n} issues</span>
                    <span className="hit-meta">{h.extra.f}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {books.length > 0 && (
          <section>
            <h2 className="display" style={{ marginBottom: 8 }}>Books and collections</h2>
            <ul className="list">
              {books.map((h) => (
                <li key={h.kind + h.ref}>
                  <Link to={h.kind === "book" ? `/book/${h.ref}` : `/series/${h.ref}`} className="hit">
                    <span className="hit-name">{h.label}</span>
                    <span className="small faint">{h.year}</span>
                    <span className="hit-meta">
                      {h.extra.f}
                      {h.kind === "series" && h.extra.n && h.extra.n > 1 ? `, ${h.extra.n} volumes` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Home() {
  const cov = useCoverage();
  return (
    <div>
      <section className="hero">
        <h1 className="display">Every DC comic, issue by issue and book by book.</h1>
        <p>
          Look up a series or a collected edition, see exactly which issues each edition reprints, and mark what you own. Mark
          an omnibus as owned and every issue inside it is checked off for you.
        </p>
      </section>
      <div className="row" style={{ marginTop: 20 }}>
        {EXAMPLES.map((e) => (
          <Link key={e} className="btn small" to={`/?q=${encodeURIComponent(e)}`}>{e}</Link>
        ))}
      </div>
      {(cov.ownedBooks.size > 0 || cov.ownedIssues.size > 0 || cov.wishBooks.size + cov.wishIssues.size > 0) && <section className="section">
        <div className="stat-line">
          <div className="stat"><strong>{cov.ownedBooks.size}</strong><span className="small muted">books in your collection</span></div>
          <div className="stat"><strong>{cov.ownedIssues.size + [...cov.viaBooks.entries()].filter(([i, v]) => !cov.ownedIssues.has(i) && v.some((x) => !x.partial)).length}</strong><span className="small muted">issues covered</span></div>
          <div className="stat"><strong>{cov.wishBooks.size + cov.wishIssues.size}</strong><span className="small muted">on your wishlist</span></div>
        </div>
        <p className="small muted" style={{ marginTop: 16 }}>
          <Link to="/collection">See your collection</Link> or <Link to="/compare">compare two editions</Link>.
        </p>
      </section>}
    </div>
  );
}
