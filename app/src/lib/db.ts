// Catalog access: a read-only SQLite file read lazily over HTTP range requests (sql.js-httpvfs).
import { createDbWorker, type WorkerHttpvfs } from "sql.js-httpvfs";
import workerUrl from "sql.js-httpvfs/dist/sqlite.worker.js?url";
import wasmUrl from "sql.js-httpvfs/dist/sql-wasm.wasm?url";

let workerPromise: Promise<WorkerHttpvfs> | null = null;

function getWorker(): Promise<WorkerHttpvfs> {
  if (!workerPromise) {
    const configUrl = new URL("db/config.json", document.baseURI).toString();
    workerPromise = createDbWorker(
      [{ from: "jsonconfig", configUrl }],
      new URL(workerUrl, document.baseURI).toString(),
      new URL(wasmUrl, document.baseURI).toString(),
    ).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

const cache = new Map<string, Promise<unknown[]>>();

export async function query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const key = sql + "\u0000" + JSON.stringify(params);
  let p = cache.get(key) as Promise<T[]> | undefined;
  if (!p) {
    p = getWorker().then((w) => (w.db.query as unknown as (s: string, p: unknown[]) => Promise<T[]>)(sql, params));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

export async function dbStats() {
  const w = await getWorker();
  return w.worker.getStats();
}

// ---------- types ----------
export type Kind = "book" | "periodical";
export interface Series {
  id: number; name: string; sort_name: string; year_began: number | null; year_ended: number | null;
  kind: Kind; format: string; cover: string | null; n_issues: number; first_issue: number | null;
}
export interface Issue {
  id: number; series_id: number; sort_code: number; number: string; title: string; key_date: string; on_sale_date: string;
  page_count: number | null; price: string; isbn: string; kind: Kind; format: string; cover: string | null;
  content_count: number | null; collected_in: number;
}
export interface IssueWithSeries extends Issue { series_name: string; series_year: number | null; }
export interface Story {
  seq: number; type: string; title: string; feature: string; page_count: number | null; script: string; pencils: string;
  inks: string; colors: string; letters: string; characters: string; synopsis: string;
}
export interface ContentRow extends IssueWithSeries { partial: number; source: string; }
export interface SearchHit {
  label: string; kind: "series" | "book"; ref: number; year: string | null;
  extra: { k?: Kind; f?: string; n?: number; num?: string; s?: number };
}

const ISSUE_COLS = `i.id, i.series_id, i.sort_code, i.number, i.title, i.key_date, i.on_sale_date, i.page_count, i.price, i.isbn,
  i.kind, i.format, i.cover, i.content_count, i.collected_in, s.name as series_name, s.year_began as series_year`;
// issue rows are clustered by (series_id, sort_code, id); issue_by_id maps an id to that key
const JOIN_ISSUE = (idExpr: string) =>
  `join issue_by_id b on b.id=${idExpr} join issue i on i.series_id=b.series_id and i.sort_code=b.sort_code and i.id=b.id
   join series s on s.id=i.series_id`;

// ---------- queries ----------
export function foldText(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function search(q: string): Promise<SearchHit[]> {
  const all = foldText(q).split(" ").filter(Boolean);
  if (!all.length) return [];
  // a 4-digit year ("Batman 1940") isn't part of the indexed name: use it to filter and rank instead
  const years = all.filter((t) => /^(19[3-9]\d|20[0-4]\d)$/.test(t));
  const words = all.filter((t) => !years.includes(t));
  const run = async (toks: string[], limit: number) => {
    const match = toks.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(" ");
    const rows = await query<{ label: string; kind: "series" | "book"; ref: number; year: string | null; extra: string; r: number }>(
      `select label, kind, ref, year, extra, rank r from search where search match ? order by rank limit ${limit}`, match,
    );
    return rows.map((r) => ({ ...r, extra: JSON.parse(r.extra || "{}") }));
  };
  let hits = words.length ? await run(words, years.length ? 1500 : 120) : [];
  if (years.length) {
    const near = hits.filter((h) => h.year && years.some((y) => Math.abs(+h.year! - +y) <= 1));
    hits = near.length ? near : await run(all, 120); // no series from that year: maybe the number is part of a title
  }
  // favour exact-ish name matches, the exact year and long runs; keep bm25 as tiebreaker
  const fq = words.join(" ");
  const score = (h: SearchHit & { r: number }) => {
    const f = foldText(h.label);
    let s = h.r;
    if (f === fq) s -= 30; else if (f.startsWith(fq)) s -= 12;
    if (years.length && h.year && years.includes(String(h.year))) s -= 20;
    if (h.kind === "series" && h.extra.k === "periodical") s -= Math.min(10, Math.log2(1 + (h.extra.n || 0)) * 1.4);
    return s;
  };
  return hits.sort((a, b) => score(a) - score(b)).slice(0, 60);
}

export async function getSeries(id: number) {
  return (await query<Series>(`select * from series where id=?`, id))[0];
}
export async function getSeriesIssues(id: number) {
  return query<Issue>(`select * from issue where series_id=? order by sort_code, id`, id);
}
export async function getIssue(id: number) {
  return (await query<IssueWithSeries>(`select ${ISSUE_COLS} from (select ? as id) x ${JOIN_ISSUE("x.id")}`, id))[0];
}
export async function getIssues(ids: number[]): Promise<IssueWithSeries[]> {
  if (!ids.length) return [];
  return query<IssueWithSeries>(
    `select ${ISSUE_COLS} from json_each(?) j ${JOIN_ISSUE("j.value")} order by s.sort_name, s.year_began, i.sort_code`,
    JSON.stringify(ids),
  );
}
export async function getStories(issueId: number) {
  return query<Story>(`select * from story where issue_id=? order by seq`, issueId);
}
/** books that reprint this issue (from resolved reprint chains, notes, twins) */
export async function getCollectedIn(issueId: number) {
  return query<IssueWithSeries & { partial: number; group_id: number | null }>(
    `select ${ISSUE_COLS}, c.partial, e.group_id from content_by_issue c ${JOIN_ISSUE("c.book_id")}
     left join edition_by_book e on e.book_id=c.book_id where c.issue_id=? order by i.key_date`,
    issueId,
  );
}
export async function getBookContent(bookId: number) {
  return query<ContentRow>(
    `select ${ISSUE_COLS}, bc.partial, bc.source from book_content bc ${JOIN_ISSUE("bc.issue_id")}
     where bc.book_id=? order by s.sort_name, s.year_began, i.sort_code`,
    bookId,
  );
}
/** raw content map for many books: book_id -> [{issue_id, partial}] (self-content books excluded) */
export async function getContentMap(bookIds: number[]) {
  const map = new Map<number, { issue: number; partial: boolean }[]>();
  if (!bookIds.length) return map;
  const rows = await query<{ book_id: number; issue_id: number; partial: number }>(
    `select bc.book_id, bc.issue_id, bc.partial from json_each(?) j join book_content bc on bc.book_id=j.value where bc.source<>'self'`,
    JSON.stringify(bookIds),
  );
  for (const r of rows) {
    if (!map.has(r.book_id)) map.set(r.book_id, []);
    map.get(r.book_id)!.push({ issue: r.issue_id, partial: !!r.partial });
  }
  return map;
}
export async function getEditions(bookId: number) {
  return query<IssueWithSeries>(
    `select ${ISSUE_COLS} from edition_by_book eb join edition e on e.group_id=eb.group_id ${JOIN_ISSUE("e.book_id")}
     where eb.book_id=? order by i.key_date`,
    bookId,
  );
}
/** every (issue, book) pair for the issues of one series — feeds the run planner and the series bar */
export async function getSeriesCoverage(seriesId: number) {
  return query<{ issue_id: number; book_id: number; partial: number }>(
    `select c.issue_id, c.book_id, c.partial from issue i join content_by_issue c on c.issue_id=i.id where i.series_id=?`,
    seriesId,
  );
}
export interface PlanBookRow {
  id: number; key_date: string; format: string; cover: string | null; number: string; title: string; series_name: string;
  series_year: number | null; total: number; issues: number[]; partial: number[];
}
/** precomputed: every book reprinting issues of this series, with the ids it covers there (one range scan) */
export async function getPlanBooks(seriesId: number): Promise<PlanBookRow[]> {
  const rows = await query<Omit<PlanBookRow, "issues" | "partial" | "id"> & { book_id: number; issues: string; partial: string }>(
    `select * from plan_book where series_id=?`, seriesId,
  );
  return rows.map((r) => ({
    ...r, id: r.book_id, issues: JSON.parse(r.issues), partial: (JSON.parse(r.partial) as (number | null)[]).filter((x): x is number => x != null),
  }));
}
export async function getMeta() {
  const rows = await query<{ key: string; value: string }>(`select key, value from meta`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------- labels ----------
export function seriesLabel(name: string, year: number | null | undefined) {
  return year ? `${name} (${year})` : name;
}
export function issueLabel(i: { series_name: string; series_year?: number | null; number: string; kind?: Kind; title?: string }) {
  const n = i.number && i.number !== "[nn]" ? ` #${i.number.replace(/^\[|\]$/g, "")}` : "";
  return `${seriesLabel(i.series_name, i.series_year)}${n}`;
}
export function bookTitle(i: { series_name: string; number: string; title?: string; series_year?: number | null }) {
  const vol = i.number && i.number !== "[nn]" ? ` Vol. ${i.number.replace(/^\[|\]$/g, "")}` : "";
  return `${i.series_name}${vol}${i.title ? `: ${i.title}` : ""}`;
}
export function year(d?: string | null) {
  return d && /^\d{4}/.test(d) ? d.slice(0, 4) : "";
}
