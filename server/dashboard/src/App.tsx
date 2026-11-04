import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router";
import { ApiError, api, isManager, type Me } from "./api";
import { CallDetailPage } from "./pages/CallDetail";
import { CallsPage } from "./pages/Calls";
import { HealthPage } from "./pages/Health";
import { SettingsPage } from "./pages/Settings";
import { SignInPage } from "./pages/SignIn";
import { UsersPage } from "./pages/Users";
import { ErrorBox, Spinner } from "./ui";

const MeContext = createContext<Me | null>(null);
export const useMe = () => {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside the signed-in app");
  return me;
};

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<Me>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });

  if (me.isPending) return <Spinner />;
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-4 pt-16">
        <ErrorBox error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  if (!me.data) return <SignInPage />;

  return (
    <MeContext.Provider value={me.data}>
      <Shell me={me.data} />
    </MeContext.Provider>
  );
}

function navItems(me: Me) {
  const items = [{ to: "/calls", label: "Calls" }];
  if (isManager(me.role)) items.push({ to: "/health", label: "Sync health" }, { to: "/users", label: "Users" });
  if (me.role === "ADMIN") items.push({ to: "/settings", label: "Settings" });
  return items;
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  });
  const items = navItems(me);
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-2 text-sm font-medium ${
      isActive
        ? "bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-white"
        : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    }`;

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur pt-[env(safe-area-inset-top)] dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-brand-600 text-xs text-white">
              UIC
            </span>
            <span className="hidden sm:inline">Call Recorder</span>
          </span>
          <nav aria-label="Main" className="ml-4 hidden gap-1 md:flex">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} className={linkCls}>
                {i.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden text-right text-xs leading-tight sm:block">
              <div className="font-medium">{me.name || me.email}</div>
              <div className="text-slate-500">
                {me.role.charAt(0) + me.role.slice(1).toLowerCase()}
                {me.team ? ` · ${me.team}` : ""}
              </div>
            </div>
            <button type="button" className="btn-ghost hidden md:inline-flex" disabled={logout.isPending} onClick={() => logout.mutate()}>
              Sign out
            </button>
            <button
              type="button"
              className="btn-ghost px-3 md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label="Menu"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
              </svg>
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-nav" aria-label="Main" className="flex flex-col gap-1 border-t border-slate-200 px-4 py-3 md:hidden dark:border-slate-800">
            <div className="px-3 pb-2 text-xs text-slate-500">
              {me.name || me.email} · {me.role.toLowerCase()}
            </div>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} className={linkCls} onClick={() => setMenuOpen(false)}>
                {i.label}
              </NavLink>
            ))}
            <button type="button" className="btn-outline mt-2" disabled={logout.isPending} onClick={() => logout.mutate()}>
              Sign out
            </button>
          </nav>
        )}
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <Routes>
          <Route path="/" element={<Navigate to="/calls" replace />} />
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/calls/:id" element={<CallDetailPage />} />
          {isManager(me.role) && <Route path="/health" element={<HealthPage />} />}
          {isManager(me.role) && <Route path="/users" element={<UsersPage />} />}
          {me.role === "ADMIN" && <Route path="/settings" element={<SettingsPage />} />}
          <Route path="*" element={<Navigate to="/calls" replace />} />
        </Routes>
      </main>
    </div>
  );
}
