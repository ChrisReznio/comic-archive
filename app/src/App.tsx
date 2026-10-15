import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import SearchPage from "./pages/SearchPage";
import SeriesPage from "./pages/SeriesPage";
import IssuePage from "./pages/IssuePage";
import BookPage from "./pages/BookPage";
import CollectionPage from "./pages/CollectionPage";
import ComparePage from "./pages/ComparePage";
import PlanPage from "./pages/PlanPage";
import AboutPage from "./pages/AboutPage";
import AccountPage from "./pages/AccountPage";
import { accountsEnabled, useSession } from "./lib/supabase";
import { useSyncEngine } from "./lib/sync";
import { BackButton, rememberSearch } from "./components/ui";

function TopSearch() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [q, setQ] = useState(params.get("q") ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (loc.pathname === "/") setQ(params.get("q") ?? ""); }, [params, loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    rememberSearch(q);
    nav(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
    ref.current?.blur();
  };
  return (
    <form className="search-form" role="search" onSubmit={submit}>
      <input
        ref={ref}
        className="search-input"
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (loc.pathname === "/") nav(e.target.value.trim() ? `/?q=${encodeURIComponent(e.target.value)}` : "/", { replace: true });
        }}
        placeholder="Search a series, book or run…"
        aria-label="Search the catalog"
        enterKeyHint="search"
      />
    </form>
  );
}

export default function App() {
  const loc = useLocation();
  const session = useSession();
  useSyncEngine();
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <div className="shell">
      <header className="top">
        <div className="top-inner">
          {loc.pathname !== "/" && <BackButton />}
          <Link to="/" className="brand display" aria-label="Longbox, home">
            <span className="brand-dots" aria-hidden="true">
              <i style={{ background: "var(--c)" }} /><i style={{ background: "var(--m)" }} /><i style={{ background: "var(--y)" }} />
            </span>
            <span className="brand-word">Longbox</span>
          </Link>
          <TopSearch />
          <nav className="nav" aria-label="Sections">
            <NavLink to="/" end>Search</NavLink>
            <NavLink to="/collection">Collection</NavLink>
            <NavLink to="/compare">Compare</NavLink>
            {accountsEnabled && <NavLink to="/account">{session ? "Account" : "Sign in"}</NavLink>}
          </nav>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/series/:id" element={<SeriesPage />} />
          <Route path="/issue/:id" element={<IssuePage />} />
          <Route path="/book/:id" element={<BookPage />} />
          <Route path="/collection" element={<CollectionPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/plan/:id" element={<PlanPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<p className="empty">This page doesn’t exist. <Link to="/">Back to search</Link>.</p>} />
        </Routes>
      </main>
      <footer className="foot">
        Data from the <a href="https://www.comics.org" target="_blank" rel="noreferrer">Grand Comics Database</a>, CC BY-SA 4.0.{" "}
        <Link to="/about">Data and offline use</Link>
      </footer>
    </div>
  );
}
