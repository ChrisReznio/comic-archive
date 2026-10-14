import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cleanNumber, useCoverage, STATUS_LABEL, type Status } from "../lib/coverage";
import { setFlag, useItem, addToCompare, type ItemType } from "../lib/user";
import { coverUrl } from "../lib/covers";

// ---------- async helper ----------
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true }); // never show the previous page's data under a new id
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (error) => alive && setState({ error, loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return <p className="loading" role="status">{children}</p>;
}
export function ErrorBox({ error }: { error: Error }) {
  return (
    <div className="error" role="alert">
      Couldn’t read the catalog: {error.message}. Check your connection and reload the page.
    </div>
  );
}

// ---------- covers ----------
const PALETTE: Record<string, [string, string, string]> = {
  // [background, dot, text]
  "Trade Paperback": ["var(--c-soft)", "color-mix(in srgb, var(--c) 30%, transparent)", "var(--ink)"],
  Hardcover: ["var(--ink)", "color-mix(in srgb, var(--paper) 14%, transparent)", "var(--paper)"],
  Omnibus: ["var(--ink)", "color-mix(in srgb, var(--m) 55%, transparent)", "var(--paper)"],
  Absolute: ["var(--ink)", "color-mix(in srgb, var(--y) 50%, transparent)", "var(--paper)"],
  "Deluxe Edition": ["var(--m-soft)", "color-mix(in srgb, var(--m) 30%, transparent)", "var(--ink)"],
  "Graphic Novel": ["var(--paper-2)", "color-mix(in srgb, var(--ink) 14%, transparent)", "var(--ink)"],
  periodical: ["var(--y-soft)", "color-mix(in srgb, var(--y) 55%, transparent)", "var(--ink)"],
};
export function Cover({ id, kind, format, title, number }: { id: number; kind: string; format: string; title: string; number?: string }) {
  const [failed, setFailed] = useState(false);
  const url = coverUrl(id);
  const pal = kind === "periodical" ? PALETTE.periodical : PALETTE[format] ?? PALETTE["Trade Paperback"];
  const num = cleanNumber(number || "");
  return (
    <div className="cover">
      {url && !failed ? (
        <img src={url} alt={`Cover of ${title}${num && num !== "nn" ? ` #${num}` : ""}`} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="ph" style={{ ["--ph-bg" as string]: pal[0], ["--ph-dot" as string]: pal[1], ["--ph-ink" as string]: pal[2] }} aria-hidden="true">
          <div>
            <div className="ph-fmt">{kind === "periodical" ? "" : format}</div>
            <div className="ph-title">{title}</div>
          </div>
          {num && num !== "nn" && <div className="ph-num">{kind === "book" ? `${num}` : `#${num}`}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- chips ----------
export function FormatChips({ format, cover }: { format: string; cover: string | null }) {
  return (
    <span className="row" style={{ gap: 4, display: "inline-flex" }}>
      <span className="chip">{format}</span>
      {cover === "hard" && format !== "Hardcover" && <span className="chip hard">Hardcover</span>}
      {cover === "soft" && format !== "Trade Paperback" && <span className="chip">Paperback</span>}
    </span>
  );
}

// ---------- own / wish toggles ----------
export function OwnButtons({ type, id, label, sub, compact }: { type: ItemType; id: number; label: string; sub?: string; compact?: boolean }) {
  const item = useItem(type, id);
  const cov = useCoverage();
  const owned = !!item?.owned, wish = !!item?.wish, read = !!item?.read;
  const readViaBook = !read && type === "issue" && cov.viaReadBooks.has(id);
  const cls = compact ? "btn small" : "btn";
  return (
    <>
      <button className={`${cls} btn-own`} aria-pressed={owned} onClick={() => setFlag(type, id, "owned", !owned, label, sub)}>
        {owned ? "✓ Owned" : "I own this"}
      </button>
      <button className={`${cls} btn-wish`} aria-pressed={wish} onClick={() => setFlag(type, id, "wish", !wish, label, sub)}>
        {wish ? "♥ On wishlist" : "♡ Wishlist"}
      </button>
      <button className={`${cls} btn-read`} aria-pressed={read} data-via={readViaBook || undefined}
        title={readViaBook ? "You read it in a book you marked as read" : undefined}
        onClick={() => setFlag(type, id, "read", !read, label, sub)}>
        {read ? "✓ Read" : readViaBook ? "✓ Read in a book" : "Mark as read"}
      </button>
    </>
  );
}

export function CompareButtons({ type, id, label }: { type: ItemType | "series"; id: number; label: string }) {
  const nav = useNavigate();
  const [done, setDone] = useState<string | null>(null);
  const add = async (side: "A" | "B") => { await addToCompare(side, type, id, label); setDone(side); };
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="small faint">Compare:</span>
      <button className="btn small" onClick={() => add("A")}>Add to A</button>
      <button className="btn small" onClick={() => add("B")}>Add to B</button>
      {done && <button className="btn small ghost" onClick={() => nav("/compare")}>See comparison</button>}
    </span>
  );
}

// ---------- run bar ----------
export interface BarIssue { id: number; number: string; sort_code: number }
export function RunBar({ issues, cls, label, onPick, dense }: {
  issues: BarIssue[]; cls: (i: BarIssue) => string; label?: (i: BarIssue) => string; onPick?: (i: BarIssue) => void; dense?: boolean;
}) {
  const nav = useNavigate();
  return (
    <div className={`runbar${dense || issues.length > 300 ? " dense" : ""}`} role="list">
      {issues.map((i) => (
        <button
          key={i.id}
          role="listitem"
          className={`cell ${cls(i)}`}
          title={`#${cleanNumber(i.number)}${label ? " · " + label(i) : ""}`}
          aria-label={`#${cleanNumber(i.number)}${label ? ", " + label(i) : ""}`}
          onClick={() => (onPick ? onPick(i) : nav(`/issue/${i.id}`))}
        />
      ))}
    </div>
  );
}
export function StatusLegend({ only }: { only?: Status[] }) {
  const all: Status[] = only ?? ["owned", "book", "partial", "wish", "none"];
  return (
    <div className="legend">
      {all.map((s) => (
        <span key={s}><i className={`cell ${s}`} aria-hidden="true" />{STATUS_LABEL[s]}</span>
      ))}
    </div>
  );
}
export function useStatusClass() {
  const cov = useCoverage();
  return (id: number) => cov.status(id);
}

export function BookCard({ id, title, format, cover, sub, kind = "book", number }: {
  id: number; title: string; format: string; cover: string | null; sub?: string; kind?: string; number?: string;
}) {
  const cov = useCoverage();
  const owned = kind === "book" ? cov.ownedBooks.has(id) : cov.ownedIssues.has(id);
  const wish = kind === "book" ? cov.wishBooks.has(id) : cov.wishIssues.has(id);
  return (
    <Link to={kind === "book" ? `/book/${id}` : `/issue/${id}`} className="book-card">
      <div style={{ position: "relative" }}>
        {owned && <span className="owned-mark k" title="Owned">✓</span>}
        {!owned && wish && <span className="owned-mark m" title="On wishlist">♥</span>}
        <Cover id={id} kind={kind} format={format} title={title} number={number} />
      </div>
      <span className="t">{title}</span>
      <span className="chips">
        <span className="chip">{format}</span>
        {cover === "hard" && <span className="chip hard">HC</span>}
        {sub && <span className="chip">{sub}</span>}
      </span>
    </Link>
  );
}
