import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { exportData, importData, useOwnedItems, useReadItems, useWishItems, setFlag, type UserItem } from "../lib/user";
import { accountsEnabled, useSession } from "../lib/supabase";
import { useCoverage } from "../lib/coverage";
import { Loading } from "../components/ui";

type Tab = "owned" | "wish" | "read" | "backup";

export default function CollectionPage() {
  const [tab, setTab] = useState<Tab>("owned");
  const owned = useOwnedItems();
  const wish = useWishItems();
  const read = useReadItems();
  const cov = useCoverage();
  const session = useSession();
  const coveredOnlyByBooks = [...cov.viaBooks.entries()].filter(([i, v]) => !cov.ownedIssues.has(i) && v.some((x) => !x.partial)).length;

  return (
    <div>
      <h1 className="display">Your collection</h1>
      <p className="muted" style={{ margin: "8px 0 20px", maxWidth: "60ch" }}>
        {session ? <>Saved in your account ({session.user.email}) and on this device.</>
          : accountsEnabled ? <>Saved on this device only. <Link to="/account">Sign in</Link> to keep it in your account and use it on other devices.</>
          : <>It’s saved in this browser. To keep a copy or move it to another device, use “Backup”.</>}
      </p>
      <div className="stat-line" style={{ marginBottom: 24 }}>
        <div className="stat"><strong>{cov.ownedBooks.size}</strong><span className="small muted">books</span></div>
        <div className="stat"><strong>{cov.ownedIssues.size}</strong><span className="small muted">single issues</span></div>
        <div className="stat"><strong>{coveredOnlyByBooks}</strong><span className="small muted">issues covered by your books</span></div>
        <div className="stat"><strong>{(read ?? []).length}</strong><span className="small muted">marked as read</span></div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "owned"} onClick={() => setTab("owned")}>Owned ({owned?.length ?? 0})</button>
        <button role="tab" aria-selected={tab === "wish"} onClick={() => setTab("wish")}>Wishlist ({wish?.length ?? 0})</button>
        <button role="tab" aria-selected={tab === "read"} onClick={() => setTab("read")}>Read ({read?.length ?? 0})</button>
        <button role="tab" aria-selected={tab === "backup"} onClick={() => setTab("backup")}>Backup</button>
      </div>
      {tab === "owned" && (owned ? <ItemList items={owned} flag="owned" /> : <Loading />)}
      {tab === "wish" && (wish ? <ItemList items={wish} flag="wish" /> : <Loading />)}
      {tab === "read" && (read ? <ItemList items={read} flag="read" /> : <Loading />)}
      {tab === "backup" && <Backup />}
    </div>
  );
}

function ItemList({ items, flag }: { items: UserItem[]; flag: "owned" | "wish" | "read" }) {
  const [filter, setFilter] = useState("");
  const { books, issueGroups } = useMemo(() => {
    const f = filter.toLowerCase();
    const match = (x: UserItem) => !f || x.label.toLowerCase().includes(f);
    const books = items.filter((x) => x.type === "book" && match(x)).sort((a, b) => a.label.localeCompare(b.label));
    const groups = new Map<string, UserItem[]>();
    for (const x of items.filter((x) => x.type === "issue" && match(x))) {
      const series = x.label.replace(/ #[^#]*$/, "");
      if (!groups.has(series)) groups.set(series, []);
      groups.get(series)!.push(x);
    }
    const issueGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, g] of issueGroups) g.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { books, issueGroups };
  }, [items, filter]);

  if (!items.length)
    return (
      <p className="empty">
        {flag === "owned"
          ? "Nothing marked yet. Find a book or a series and tap “I own this”."
          : flag === "read" ? "Nothing marked as read yet. Tap “Mark as read” on any book or issue."
          : "Your wishlist is empty. Tap “Wishlist” on any book or issue to save it here."}{" "}
        <Link to="/">Go to search</Link>
      </p>
    );
  return (
    <div>
      <input className="input" style={{ width: "100%", maxWidth: 360 }} placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
      {books.length > 0 && (
        <section className="section" style={{ marginTop: 20 }}>
          <h2 className="display" style={{ marginBottom: 8 }}>Books</h2>
          <ul className="list">
            {books.map((b) => (
              <li key={b.key} className="side-entry">
                <span><Link to={`/book/${b.id}`}>{b.label}</Link> <span className="small faint">{b.sub}</span></span>
                <button className="btn small ghost" onClick={() => setFlag("book", b.id, flag, false, b.label)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {issueGroups.length > 0 && (
        <section className="section">
          <h2 className="display" style={{ marginBottom: 8 }}>Single issues</h2>
          {issueGroups.map(([series, g]) => (
            <div key={series} className="content-group">
              <h3>{series} <span className="small faint">{g.length}</span></h3>
              <div className="issue-pills">
                {g.map((x) => (
                  <Link key={x.key} to={`/issue/${x.id}`} className={`pill ${flag === "owned" ? "owned" : flag === "read" ? "book" : "wish"}`}>
                    {x.label.match(/#([^#]*)$/)?.[1] ?? "?"}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Backup() {
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const download = async () => {
    const blob = new Blob([await exportData()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `longbox-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg("Backup downloaded.");
  };
  const upload = async (mode: "merge" | "replace") => {
    const f = file.current?.files?.[0];
    if (!f) { setMsg("Choose a backup file first."); return; }
    try {
      const n = await importData(await f.text(), mode);
      setMsg(`Backup imported: ${n} items.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <p>Download a file with everything you’ve marked. You can import it in another browser or device.</p>
      <div><button className="btn solid" onClick={download}>Download backup</button></div>
      <h2 className="display" style={{ marginTop: 20 }}>Import</h2>
      <input ref={file} type="file" accept="application/json,.json" aria-label="Backup file" />
      <div className="row">
        <button className="btn" onClick={() => upload("merge")}>Add to my collection</button>
        <button className="btn" onClick={() => upload("replace")}>Replace everything</button>
      </div>
      {msg && <p className="banner" role="status">{msg}</p>}
    </div>
  );
}
