import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { accountsEnabled, clearAuthError, friendlyAuthError, peekAuthError, supabase, useSession } from "../lib/supabase";
import { signOutAndClear, syncNow, useSyncState } from "../lib/sync";
import { usePendingCount } from "../lib/user";
import { Loading } from "../components/ui";

export default function AccountPage() {
  const session = useSession();
  if (!accountsEnabled) return <p className="empty">Accounts aren’t set up in this version of the app. Your collection is saved on this device.</p>;
  if (session === undefined) return <Loading />;
  return (
    <div style={{ maxWidth: "60ch" }}>
      <h1 className="display">Account</h1>
      {session ? <SignedIn email={session.user.email ?? ""} /> : <SignIn />}
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(() => peekAuthError());

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true); setErr(null); clearAuthError();
    const redirect = window.location.origin + window.location.pathname; // back to the app root; the ?code is picked up there
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect, shouldCreateUser: true } });
    setBusy(false);
    if (error) setErr(friendlyAuthError((error as { code?: string }).code, error.message)); else setSent(email.trim());
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || !sent) return;
    setBusy(true); setErr(null); clearAuthError();
    const { error } = await supabase.auth.verifyOtp({ email: sent, token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setErr(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Check you typed the code from the newest email." : error.message);
  };

  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <p className="muted">
        Sign in to keep your collection, wishlist and reading log in your account and use them on any device. What you’ve already
        marked on this device is added to your account the first time you sign in.
      </p>
      {!sent ? (
        <form className="stack" onSubmit={send}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="small muted">Email</span>
            <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <div className="row">
            <button className="btn solid" disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
            <button type="button" className="btn ghost" disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}
              onClick={() => { setErr(null); clearAuthError(); setSent(email.trim()); }}>I already have a code</button>
          </div>
          <p className="small faint">No password needed. We’ll email you a link and a code. Open the link in this browser, or type the code here.</p>
        </form>
      ) : (
        <div className="stack">
          <p className="banner" role="status">We sent an email to <strong>{sent}</strong>. Open its link in this browser, or type the code from it below. Only the newest email works.</p>
          <form className="row" onSubmit={verify}>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="Code from the email"
              value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="Code from the email" />
            <button className="btn" disabled={busy || code.trim().length < 6}>Sign in with code</button>
          </form>
          <div><button className="btn small ghost" onClick={() => { setSent(null); setCode(""); }}>Use a different email</button></div>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

function SignedIn({ email }: { email: string }) {
  const sync = useSyncState();
  const pending = usePendingCount();
  const [leaving, setLeaving] = useState(false);
  const status =
    sync.status === "syncing" ? "Syncing…"
    : sync.status === "error" ? `Couldn’t sync: ${sync.error}. Your changes are kept on this device and will sync later.`
    : !navigator.onLine ? "You’re offline. Changes are saved on this device and will sync when you’re back online."
    : pending > 0 ? `${pending} ${pending === 1 ? "change" : "changes"} waiting to sync.`
    : sync.lastSync ? `Up to date. Last synced at ${new Date(sync.lastSync).toLocaleTimeString()}.`
    : "Up to date.";
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <dl className="kv">
        <dt>Signed in as</dt><dd>{email}</dd>
        <dt>Sync</dt><dd>{status}</dd>
      </dl>
      <div className="row">
        <button className="btn" onClick={() => void syncNow()} disabled={sync.status === "syncing"}>Sync now</button>
        <Link className="btn ghost" to="/collection">See your collection</Link>
      </div>
      <section className="section">
        <h2 className="display">Sign out</h2>
        <p className="muted">Your collection stays in your account. Signing out removes it from this device.</p>
        {!leaving ? (
          <div><button className="btn" onClick={() => setLeaving(true)}>Sign out</button></div>
        ) : (
          <div className="row">
            <button className="btn solid" onClick={() => void signOutAndClear()}>Sign out and remove from this device</button>
            <button className="btn ghost" onClick={() => setLeaving(false)}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}
