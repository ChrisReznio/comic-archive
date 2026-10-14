// User data is stored in this browser (IndexedDB) so the app works offline. When signed in, lib/sync.ts mirrors it
// to the account: every local change is marked dirty and pushed; deletions are kept as tombstones until synced.
import Dexie, { type Table } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";

export type ItemType = "issue" | "book";
export type Flag = "owned" | "wish" | "read";
export interface UserItem {
  key: string; // "i:123" | "b:456"
  type: ItemType;
  id: number;
  owned: 0 | 1;
  wish: 0 | 1;
  read: 0 | 1;
  label: string; // snapshot for lists, so the collection renders without catalog lookups
  sub?: string;
  updatedAt: number;
  dirty: 0 | 1; // changed locally, not yet pushed to the account
}
export type CompareSide = "A" | "B";
export interface CompareEntry {
  key: string; // side + ":" + type + ":" + id
  side: CompareSide;
  type: ItemType | "series";
  id: number;
  label: string;
  addedAt: number;
}

class UserDb extends Dexie {
  items!: Table<UserItem, string>;
  compare!: Table<CompareEntry, string>;
  constructor() {
    super("longbox-user");
    this.version(1).stores({ items: "key, type, owned, wish, updatedAt", compare: "key, side, addedAt" });
    this.version(2)
      .stores({ items: "key, type, owned, wish, read, dirty, updatedAt", compare: "key, side, addedAt" })
      .upgrade((tx) => tx.table("items").toCollection().modify((it: UserItem) => { it.read = 0; it.dirty = 1; }));
  }
}
export const userDb = new UserDb();

/** Set by the sync module: when signed in, removals become tombstones so they reach the account. */
let keepTombstones = false;
export function setKeepTombstones(v: boolean) { keepTombstones = v; }
const listeners = new Set<() => void>();
export function onLocalChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((f) => f());

export const itemKey = (type: ItemType, id: number) => `${type === "issue" ? "i" : "b"}:${id}`;
const isEmpty = (it: UserItem) => !it.owned && !it.wish && !it.read;

export function useItem(type: ItemType, id: number | undefined) {
  return useLiveQuery(() => (id ? userDb.items.get(itemKey(type, id)) : undefined), [type, id]);
}

function apply(cur: UserItem | undefined, key: string, type: ItemType, id: number, flag: Flag, value: boolean, label: string, sub?: string): UserItem {
  const next: UserItem = cur
    ? { ...cur, label: label || cur.label, sub: sub ?? cur.sub, updatedAt: Date.now(), dirty: 1 }
    : { key, type, id, owned: 0, wish: 0, read: 0, label, sub, updatedAt: Date.now(), dirty: 1 };
  next[flag] = value ? 1 : 0;
  if (flag === "owned" && value) next.wish = 0; // buying it takes it off the wishlist
  return next;
}

export async function setFlag(type: ItemType, id: number, flag: Flag, value: boolean, label: string, sub?: string) {
  await setFlagMany(type, [{ id, label, sub }], flag, value);
}

export async function setFlagMany(type: ItemType, entries: { id: number; label: string; sub?: string }[], flag: Flag, value: boolean) {
  await userDb.transaction("rw", userDb.items, async () => {
    const keys = entries.map((e) => itemKey(type, e.id));
    const cur = await userDb.items.bulkGet(keys);
    const puts: UserItem[] = [], dels: string[] = [];
    entries.forEach((e, k) => {
      const next = apply(cur[k], keys[k], type, e.id, flag, value, e.label, e.sub);
      if (isEmpty(next) && !keepTombstones) { if (cur[k]) dels.push(keys[k]); }
      else if (isEmpty(next) && !cur[k]) { /* nothing to record */ }
      else puts.push(next);
    });
    if (puts.length) await userDb.items.bulkPut(puts);
    if (dels.length) await userDb.items.bulkDelete(dels);
  });
  changed();
}

export function useOwnedItems() {
  return useLiveQuery(() => userDb.items.where("owned").equals(1).toArray(), [], undefined);
}
export function useWishItems() {
  return useLiveQuery(() => userDb.items.where("wish").equals(1).toArray(), [], undefined);
}
export function useReadItems() {
  return useLiveQuery(() => userDb.items.where("read").equals(1).toArray(), [], undefined);
}
export function usePendingCount() {
  return useLiveQuery(() => userDb.items.where("dirty").equals(1).count(), [], 0);
}

// ---------- compare lists ----------
export function useCompare() {
  return useLiveQuery(() => userDb.compare.orderBy("addedAt").toArray(), [], [] as CompareEntry[]);
}
export async function addToCompare(side: CompareSide, type: CompareEntry["type"], id: number, label: string) {
  await userDb.compare.put({ key: `${side}:${type}:${id}`, side, type, id, label, addedAt: Date.now() });
}
export async function removeFromCompare(key: string) {
  await userDb.compare.delete(key);
}
export async function clearCompare(side?: CompareSide) {
  if (side) await userDb.compare.where("side").equals(side).delete();
  else await userDb.compare.clear();
}

// ---------- backup ----------
export async function exportData() {
  const items = (await userDb.items.toArray()).filter((x) => !isEmpty(x)).map(({ dirty: _d, ...rest }) => rest);
  return JSON.stringify({ app: "longbox", version: 2, exportedAt: new Date().toISOString(), items }, null, 1);
}
export async function importData(json: string, mode: "merge" | "replace") {
  const data = JSON.parse(json);
  if (data?.app !== "longbox" || !Array.isArray(data.items)) throw new Error("This file isn’t a Longbox backup.");
  const now = Date.now();
  const items: UserItem[] = data.items
    .filter((x: UserItem) => x && typeof x.key === "string" && typeof x.id === "number")
    .map((x: UserItem) => ({ ...x, read: x.read ? 1 : 0, owned: x.owned ? 1 : 0, wish: x.wish ? 1 : 0, updatedAt: now, dirty: 1 }));
  await userDb.transaction("rw", userDb.items, async () => {
    if (mode === "replace") {
      if (keepTombstones) await userDb.items.toCollection().modify((it: UserItem) => { it.owned = 0; it.wish = 0; it.read = 0; it.dirty = 1; it.updatedAt = now; });
      else await userDb.items.clear();
    }
    await userDb.items.bulkPut(items);
  });
  changed();
  return items.length;
}
