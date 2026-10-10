import { useEffect, useState } from "react";
import { useAsync } from "../components/ui";
import { getMeta } from "../lib/db";
import { downloadOffline, offlineStatus, removeOffline } from "../lib/offline";

export default function AboutPage() {
  const { data } = useAsync(getMeta, []);
  return (
    <div style={{ maxWidth: "66ch" }}>
      <h1 className="display">Data and offline use</h1>
      <div className="stack" style={{ marginTop: 16 }}>
        <p>
          The catalog comes from the <a href="https://www.comics.org" target="_blank" rel="noreferrer">Grand Comics Database</a>, a
          volunteer-built database published under CC BY-SA 4.0. It covers every DC series and book published in the US, without
          variant covers.
        </p>
        <p>
          A book’s contents are worked out by following reprints back to the original issue, even when a new edition reprints an older
          one. When GCD has no reprint links, the book’s description or a twin edition is used instead, and the book page says so.
        </p>
        <p>Your collection is stored only in this browser. Nobody else can see it.</p>
        {data && <p className="small faint">Data version: {data.source}, built {data.built_app ?? data.built}.</p>}
      </div>
      <Offline />
    </div>
  );
}

function Offline() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof offlineStatus>> | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => offlineStatus().then(setSt, (e) => setErr(e.message));
  useEffect(() => { refresh(); }, []);
  if (!st) return null;
  if (!st.supported) return <p className="small faint">This browser can’t store the catalog for offline use.</p>;
  const mb = Math.round(st.bytes / 1e6);
  const complete = st.cached === st.total;
  return (
    <section className="section">
      <h2 className="display">Use it offline</h2>
      <p className="muted">
        The app opens without a connection, but the catalog is read piece by piece from the server. Save it to this device ({mb} MB)
        and everything works offline.
      </p>
      <p className="small">
        {complete ? "The catalog is saved on this device." : st.cached ? `Partly saved (${st.cached} of ${st.total}).` : "Not saved yet."}
      </p>
      <div className="row">
        {!complete && (
          <button className="btn solid" disabled={!!progress} onClick={async () => {
            setErr(null);
            try { await downloadOffline((d, t) => setProgress([d, t])); } catch (e) { setErr((e as Error).message); }
            setProgress(null); refresh();
          }}>
            {progress ? `Saving ${progress[0]} of ${progress[1]}…` : `Save catalog (${mb} MB)`}
          </button>
        )}
        {st.cached > 0 && !progress && <button className="btn" onClick={async () => { await removeOffline(); refresh(); }}>Remove from device</button>}
      </div>
      {err && <p className="error" style={{ marginTop: 12 }}>{err}</p>}
    </section>
  );
}
