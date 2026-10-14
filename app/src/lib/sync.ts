// Two-way sync between the local collection (IndexedDB) and the signed-in account (Supabase table user_items).
// Conflict rule: last write wins, per item, by updated_at. Runs on sign-in, on start, when back online,
// shortly after local changes, and every few minutes.
import { useEffect, useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import { onLocalChange, setKeepTombstones, userDb, type UserItem } from "./user";

interface Row {
  user_id: string; item_type: "issue" | "book"; item_id: number; owned: boolean; wish: boolean; read: boolean;
  label: string | null; sub: string | null; updated_at: string; synced_at: string;
}
type State = { status: "off" | "idle" | "syncing" | "error"; lastSync?: number; error?: string; userId?: string };
let state: State = { status: "off" };
const subs = new Set<() => void>();
const set = (s: Partial<State>) => { state = { ...state, ...s }; subs.forEach((f) => f()); };
export function useSyncState() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
}

const lastPullKey = (uid: string) => `longbox-lastpull-${uid}`;
const keyOf = (r: Row) => `${r.item_type === "issue" ? "i" : "b"}:${r.item_id}`;
const empty = (x: { owned: unknown; wish: unknown; read: unknown }) => !x.owned && !x.wish && !x.read;

let running: Promise<void> | null = null;
let again = false;

export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = doSync().finally(() => {
    running = null;
    if (again) { again = false; void syncNow(); }
  });
  return running;
}

async function doSync() {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) { set({ status: "off", userId: undefined }); return; }
  if (!navigator.onLine) { set({ status: "idle" }); return; }
  set({ status: "syncing", userId: uid, error: undefined });
  try {
    // ---- pull: rows written to the account since the last pull, by server time (paged) ----
    const since = localStorage.getItem(lastPullKey(uid)) ?? "1970-01-01T00:00:00Z";
    let maxSeen = since, from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data: rows, error } = await supabase.from("user_items").select("*").gte("synced_at", since)
        .order("synced_at", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      if (!rows?.length) break;
      await userDb.transaction("rw", userDb.items, async () => {
        for (const r of rows as Row[]) {
          const k = keyOf(r), remoteT = Date.parse(r.updated_at);
          const local = await userDb.items.get(k);
          if (local && local.updatedAt > remoteT && local.dirty) continue; // our newer local edit wins; pushed below
          if (empty(r)) { if (local) await userDb.items.delete(k); continue; }
          const it: UserItem = {
            key: k, type: r.item_type, id: r.item_id, owned: r.owned ? 1 : 0, wish: r.wish ? 1 : 0, read: r.read ? 1 : 0,
            label: r.label ?? local?.label ?? "", sub: r.sub ?? local?.sub, updatedAt: remoteT, dirty: 0,
          };
          await userDb.items.put(it);
        }
      });
      maxSeen = (rows[rows.length - 1] as Row).synced_at;
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    // ---- push: everything changed locally ----
    const dirty = await userDb.items.where("dirty").equals(1).toArray();
    for (let i = 0; i < dirty.length; i += 500) {
      const batch = dirty.slice(i, i + 500);
      const { error } = await supabase.from("user_items").upsert(
        batch.map((x) => ({
          user_id: uid, item_type: x.type, item_id: x.id, owned: !!x.owned, wish: !!x.wish, read: !!x.read,
          label: x.label, sub: x.sub ?? null, updated_at: new Date(x.updatedAt).toISOString(),
        })),
        { onConflict: "user_id,item_type,item_id" },
      );
      if (error) throw error;
      await userDb.transaction("rw", userDb.items, async () => {
        for (const x of batch) {
          const cur = await userDb.items.get(x.key);
          if (!cur || cur.updatedAt !== x.updatedAt) continue; // edited again meanwhile: stays dirty
          if (empty(cur)) await userDb.items.delete(x.key);
          else await userDb.items.update(x.key, { dirty: 0 });
        }
      });
    }
    // our own pushes come back on the next pull; they match local data, so that is harmless
    localStorage.setItem(lastPullKey(uid), maxSeen);
    set({ status: "idle", lastSync: Date.now() });
  } catch (e) {
    set({ status: "error", error: (e as Error).message || String(e) });
  }
}

/** Wire sync to auth + connectivity + local edits. Call once at app start. */
export function useSyncEngine() {
  useEffect(() => {
    if (!supabase) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void syncNow(), 1500); };
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setKeepTombstones(!!session);
      if (!session) { set({ status: "off", userId: undefined }); return; }
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") void syncNow();
    });
    const offChange = onLocalChange(soon);
    const onOnline = () => void syncNow();
    const onVisible = () => { if (document.visibilityState === "visible") void syncNow(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => void syncNow(), 5 * 60 * 1000);
    return () => {
      data.subscription.unsubscribe(); offChange(); clearTimeout(timer); clearInterval(interval);
      window.removeEventListener("online", onOnline); document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** Sign out and remove this account's collection from the device (it stays in the account). */
export async function signOutAndClear() {
  await syncNow();
  const uid = state.userId;
  await supabase?.auth.signOut();
  setKeepTombstones(false);
  await userDb.items.clear();
  if (uid) localStorage.removeItem(lastPullKey(uid));
  set({ status: "off", userId: undefined });
}
