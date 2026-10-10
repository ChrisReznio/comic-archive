// Coverage logic: what the user owns (directly or through books), ranges, comparisons and run planning.
import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getContentMap, type IssueWithSeries } from "./db";
import { useOwnedItems, useWishItems } from "./user";

export type Status = "owned" | "book" | "partial" | "wish" | "none";

export interface Coverage {
  ready: boolean;
  ownedIssues: Set<number>;
  ownedBooks: Set<number>;
  wishIssues: Set<number>;
  wishBooks: Set<number>;
  /** issue -> owned books that contain it (full or partial) */
  viaBooks: Map<number, { book: number; partial: boolean }[]>;
  status(issueId: number): Status;
}

const empty: Coverage = {
  ready: false, ownedIssues: new Set(), ownedBooks: new Set(), wishIssues: new Set(), wishBooks: new Set(),
  viaBooks: new Map(), status: () => "none",
};
const Ctx = createContext<Coverage>(empty);

export function CoverageProvider({ children }: { children: ReactNode }) {
  const owned = useOwnedItems();
  const wish = useWishItems();
  const [viaBooks, setVia] = useState<Coverage["viaBooks"]>(new Map());
  const [loaded, setLoaded] = useState(false);

  const ownedBooks = useMemo(() => new Set((owned ?? []).filter((x) => x.type === "book").map((x) => x.id)), [owned]);
  const ownedIssues = useMemo(() => new Set((owned ?? []).filter((x) => x.type === "issue").map((x) => x.id)), [owned]);
  const wishIssues = useMemo(() => new Set((wish ?? []).filter((x) => x.type === "issue").map((x) => x.id)), [wish]);
  const wishBooks = useMemo(() => new Set((wish ?? []).filter((x) => x.type === "book").map((x) => x.id)), [wish]);
  const booksKey = [...ownedBooks].sort((a, b) => a - b).join(",");

  useEffect(() => {
    let alive = true;
    if (owned === undefined) return;
    getContentMap([...ownedBooks])
      .then((map) => {
        if (!alive) return;
        const via: Coverage["viaBooks"] = new Map();
        for (const [book, rows] of map)
          for (const r of rows) {
            if (!via.has(r.issue)) via.set(r.issue, []);
            via.get(r.issue)!.push({ book, partial: r.partial });
          }
        setVia(via);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booksKey, owned === undefined]);

  const value = useMemo<Coverage>(() => ({
    ready: loaded && owned !== undefined,
    ownedIssues, ownedBooks, wishIssues, wishBooks, viaBooks,
    status(id) {
      if (ownedIssues.has(id)) return "owned";
      const v = viaBooks.get(id);
      if (v?.some((x) => !x.partial)) return "book";
      if (v?.length) return "partial";
      if (wishIssues.has(id)) return "wish";
      return "none";
    },
  }), [loaded, owned, ownedIssues, ownedBooks, wishIssues, wishBooks, viaBooks]);

  return createElement(Ctx.Provider, { value }, children);
}
export const useCoverage = () => useContext(Ctx);

export const STATUS_LABEL: Record<Status, string> = {
  owned: "Own the issue",
  book: "Own it in a collection",
  partial: "Partly in a collection",
  wish: "On wishlist",
  none: "Missing",
};

// ---------- ranges ----------
export function cleanNumber(n: string) {
  return (n || "").replace(/^\[|\]$/g, "");
}
/** "#1–5, #7, #9–10" from issues of ONE series sorted by sort_code; consecutive = adjacent in the series order */
export function compressRun(issues: { number: string; sort_code: number }[], order?: Map<number, number>, ids?: number[]) {
  if (!issues.length) return "";
  const parts: string[] = [];
  let start = 0;
  for (let k = 1; k <= issues.length; k++) {
    const adjacent =
      k < issues.length &&
      (order && ids
        ? order.get(ids[k]) === (order.get(ids[k - 1]) ?? -9) + 1
        : /^\d+$/.test(cleanNumber(issues[k].number)) && /^\d+$/.test(cleanNumber(issues[k - 1].number)) &&
          +cleanNumber(issues[k].number) === +cleanNumber(issues[k - 1].number) + 1);
    if (!adjacent) {
      const a = cleanNumber(issues[start].number), b = cleanNumber(issues[k - 1].number);
      parts.push(start === k - 1 ? `#${a}` : `#${a}–${b}`);
      start = k;
    }
  }
  return parts.join(", ");
}

export interface SeriesGroup<T> { seriesId: number; name: string; year: number | null; items: T[] }
export function groupBySeries<T extends IssueWithSeries>(rows: T[]): SeriesGroup<T>[] {
  const m = new Map<number, SeriesGroup<T>>();
  for (const r of rows) {
    if (!m.has(r.series_id)) m.set(r.series_id, { seriesId: r.series_id, name: r.series_name, year: r.series_year, items: [] });
    m.get(r.series_id)!.items.push(r);
  }
  for (const g of m.values()) g.items.sort((a, b) => a.sort_code - b.sort_code);
  return [...m.values()];
}

// ---------- run planner: greedy weighted set cover ----------
export interface PlanBook { id: number; issues: Set<number>; partial: Set<number>; cost: number }
export interface PlanResult { picks: { book: number; adds: number[] }[]; uncovered: number[] }

/**
 * Pick books that cover `target` issues with as few (cheap) books as possible.
 * Greedy by new-issues-per-cost; partial content never counts as covered. Classic ln(n)-approximation, fine at this size.
 */
export function planRun(target: number[], books: PlanBook[]): PlanResult {
  const need = new Set(target);
  const picks: PlanResult["picks"] = [];
  const pool = books.filter((b) => [...b.issues].some((i) => need.has(i)));
  while (need.size) {
    let best: PlanBook | null = null, bestScore = 0, bestAdds: number[] = [];
    for (const b of pool) {
      const adds = [...b.issues].filter((i) => need.has(i) && !b.partial.has(i));
      if (!adds.length) continue;
      const score = adds.length / b.cost;
      if (score > bestScore || (score === bestScore && best && adds.length > bestAdds.length)) {
        best = b; bestScore = score; bestAdds = adds;
      }
    }
    if (!best) break;
    picks.push({ book: best.id, adds: bestAdds });
    for (const i of bestAdds) need.delete(i);
    pool.splice(pool.indexOf(best), 1);
  }
  // drop picks whose contribution is fully covered by the other picks, then recompute what each one adds
  const byId = new Map(books.map((b) => [b.id, b]));
  const full = (id: number) => { const b = byId.get(id)!; return [...b.issues].filter((i) => !b.partial.has(i)); };
  const targetSet = new Set(target);
  let kept = picks.map((p) => p.book);
  for (let k = kept.length - 1; k >= 0; k--) {
    const others = new Set(kept.filter((_, j) => j !== k).flatMap(full));
    if (full(kept[k]).filter((i) => targetSet.has(i)).every((i) => others.has(i))) kept = kept.filter((_, j) => j !== k);
  }
  const seen = new Set<number>();
  const finalPicks = kept.map((book) => {
    const adds = full(book).filter((i) => targetSet.has(i) && !seen.has(i));
    adds.forEach((i) => seen.add(i));
    return { book, adds };
  });
  return { picks: finalPicks, uncovered: [...need] };
}
