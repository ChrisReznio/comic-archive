// Supabase client (auth + user data). Configured at build time; without these env vars the app runs local-only.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "longbox-auth" },
      })
    : null;

export const accountsEnabled = !!supabase;

// ---------- coming back from an email link ----------
// Supabase sends people back to the app root as ?code=… (success) or with ?error…&error_code=… and the same in the
// #fragment. A "#error=…" fragment isn't a route for the hash router, so read it here, before the router starts,
// remember what happened, and land on the account page with a clean address.
const AUTH_ERR_KEY = "longbox-auth-error";
const AUTH_KEYS = ["code", "error", "error_code", "error_description", "sb"];

function captureAuthReturn(): string | null {
  if (typeof window === "undefined") return null;
  const u = new URL(window.location.href);
  const frag = u.hash && !u.hash.startsWith("#/") ? new URLSearchParams(u.hash.slice(1)) : null;
  const fragIsAuth = !!frag && AUTH_KEYS.some((k) => frag.has(k));
  const q = u.searchParams;
  const errCode = q.get("error_code") ?? frag?.get("error_code") ?? null;
  const errDesc = q.get("error_description") ?? frag?.get("error_description") ?? q.get("error") ?? frag?.get("error") ?? null;
  const code = q.get("code");
  if (!errCode && !errDesc && !code && !fragIsAuth) return null;
  if (errCode || errDesc) setAuthError(friendlyAuthError(errCode, errDesc));
  for (const k of AUTH_KEYS) q.delete(k);
  window.history.replaceState(null, "", u.pathname + (q.toString() ? `?${q}` : "") + "#/account");
  return code;
}

export function friendlyAuthError(code: string | null | undefined, desc?: string | null) {
  if (code === "otp_expired" || /invalid or has expired/i.test(desc ?? ""))
    return "That link has expired or was already used. Each link works once, for an hour, and only the newest one works if you asked for more than one. Type the code from the email instead, or request a new link.";
  if (code === "pkce_code_verifier_not_found")
    return "That link was opened in a different browser or app from the one where you asked for it. Your email is confirmed; to finish, open the link in the browser where you asked for it, or request a new one here and type the code from the email.";
  if (code === "over_email_send_rate_limit" || /rate limit/i.test(desc ?? ""))
    return "Too many emails were sent in a short time. Wait a while and try again, or use the code from the last email you got.";
  return desc ? `Sign-in didn’t work: ${desc}` : "Sign-in didn’t work. Request a new link.";
}
function setAuthError(msg: string) {
  try { sessionStorage.setItem(AUTH_ERR_KEY, JSON.stringify({ msg, at: Date.now() })); } catch { /* private mode */ }
}
/** The error from the last email link, if any (kept for a few minutes so a reload doesn't swallow it). */
export function peekAuthError(): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(AUTH_ERR_KEY) || "null") as { msg: string; at: number } | null;
    return v && Date.now() - v.at < 10 * 60_000 ? v.msg : null;
  } catch { return null; }
}
export function clearAuthError() {
  try { sessionStorage.removeItem(AUTH_ERR_KEY); } catch { /* ignore */ }
}

const returnedCode = captureAuthReturn();
let startup: Promise<void> | null = null;
/** Exchanges the ?code from the link for a session exactly once (StrictMode runs effects twice). */
function finishSignIn() {
  if (!startup) {
    startup = (async () => {
      if (!supabase || !returnedCode) return;
      const { error } = await supabase.auth.exchangeCodeForSession(returnedCode);
      if (error) setAuthError(friendlyAuthError((error as { code?: string }).code, error.message));
    })();
  }
  return startup;
}

const SessionCtx = createContext<Session | null | undefined>(null);

/** One shared auth subscription for the whole app. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  useEffect(() => {
    if (!supabase) return;
    finishSignIn().finally(() => supabase!.auth.getSession().then(({ data }) => setSession(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return createElement(SessionCtx.Provider, { value: session }, children);
}
/** Current session. undefined = still loading. */
export const useSession = () => useContext(SessionCtx);
/** Collection, wishlist and read marks need an account (when accounts are configured). */
export function useCanTrack() {
  const session = useSession();
  return !accountsEnabled || !!session;
}
