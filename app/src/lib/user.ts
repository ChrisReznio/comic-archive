// User data lives only in this browser (IndexedDB). Export/import keeps a backup or moves it to another device.
import Dexie, { type Table } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";

export type ItemType = "issue" | "book";
export interface UserItem {
  key: string; // "i:123" | "b:456"
  type: ItemType;
  id: number;
  owned: 0 | 1;
  wish: 0 | 1;
  label: string; // snapshot for lists, so the collection renders without catalog lookups
  sub?: string;
  updatedAt: number;
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
  }
}
export const userDb = new UserDb();

export const itemKey = (type: ItemType, id: number) => `${type === "issue" ? "i" : "b"}:${id}`;

export function useItem(type: ItemType, id: number | undefined) {
  return useLiveQuery(() => (id ? userDb.items.get(itemKey(type, id)) : undefined), [type, id]);
}

export async function setFlag(type: ItemType, id: number, flag: "owned" | "wish", value: boolean, label: string, sub?: string) {
  const key = itemKey(type, id);
  await userDb.transaction("rw", userDb.items, async () => {
    const cur = await userDb.items.get(key);
    const next: UserItem = cur
      ? { ...cur, label, sub: sub ?? cur.sub, updatedAt: Date.now() }
      : { key, type, id, owned: 0, wish: 0, label, sub, updatedAt: Date.now() };
    next[flag] = value ? 1 : 0;
    if (flag === "owned" && value) next.wish = 0; // buying it takes it off the wishlist
    if (!next.owned && !next.wish) await userDb.items.delete(key);
    else await userDb.items.put(next);
  });
}

export async function setFlagMany(type: ItemType, entries: { id: number; label: string; sub?: string }[], flag: "owned" | "wish", value: boolean) {
  await userDb.transaction("rw", userDb.items, async () => {
    const keys = entries.map((e) => itemKey(type, e.id));
    const cur = await userDb.items.bulkGet(keys);
    const puts: UserItem[] = [], dels: string[] = [];
    entries.forEach((e, k) => {
      const c = cur[k];
      const next: UserItem = c ? { ...c, updatedAt: Date.now() } : { key: keys[k], type, id: e.id, owned: 0, wish: 0, label: e.label, sub: e.sub, updatedAt: Date.now() };
      next[flag] = value ? 1 : 0;
      if (flag === "owned" && value) next.wish = 0;
      if (!next.owned && !next.wish) { if (c) dels.push(keys[k]); } else puts.push(next);
    });
    if (puts.length) await userDb.items.bulkPut(puts);
    if (dels.length) await userDb.items.bulkDelete(dels);
  });
}

export function useOwnedItems() {
  return useLiveQuery(() => userDb.items.where("owned").equals(1).toArray(), [], undefined);
}
export function useWishItems() {
  return useLiveQuery(() => userDb.items.where("wish").equals(1).toArray(), [], undefined);
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
  const items = await userDb.items.toArray();
  return JSON.stringify({ app: "longbox", version: 1, exportedAt: new Date().toISOString(), items }, null, 1);
}
export async function importData(json: string, mode: "merge" | "replace") {
  const data = JSON.parse(json);
  if (data?.app !== "longbox" || !Array.isArray(data.items)) throw new Error("This file isn’t a Longbox backup.");
  const items: UserItem[] = data.items.filter((x: UserItem) => x && typeof x.key === "string" && typeof x.id === "number");
  await userDb.transaction("rw", userDb.items, async () => {
    if (mode === "replace") await userDb.items.clear();
    await userDb.items.bulkPut(items);
  });
  return items.length;
}
