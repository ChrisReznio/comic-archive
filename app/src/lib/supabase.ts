// Supabase client (auth + user data). Configured at build time; without these env vars the app runs local-only.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "longbox-auth" },
      })
    : null;

export const accountsEnabled = !!supabase;

/** Current session, kept up to date. undefined = still loading. */
export function useSession() {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/** The magic link comes back as ?code=… before the #route; drop it from the address bar once handled. */
export function cleanAuthParams() {
  const u = new URL(window.location.href);
  if (u.searchParams.has("code") || u.searchParams.has("error_description")) {
    u.searchParams.delete("code"); u.searchParams.delete("error"); u.searchParams.delete("error_code"); u.searchParams.delete("error_description");
    window.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
  }
}
