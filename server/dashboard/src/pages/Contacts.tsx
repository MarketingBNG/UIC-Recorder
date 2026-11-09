import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { api, isManager, qs, type ContactPage, type ContactStatus, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, formatShortWhen, isOverdue, personName } from "../format";
import { ContactStatusBadge, Empty, ErrorBox, PageHeader, Spinner } from "../ui";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Sub-navigation shared by the Activity Tracker pages. */
export function TrackerTabs() {
  const me = useMe();
  const [params] = useSearchParams();
  const due = params.get("due");
  const path = useLocation().pathname;
  const cls = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      active ? "bg-brand-600 text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    }`;
  return (
    <nav aria-label="Activity tracker" className="mb-4 flex flex-wrap gap-2">
      <Link to="/activity" className={cls(path === "/activity" && !due)}>
        All contacts
      </Link>
      <Link to="/activity?due=today" className={cls(path === "/activity" && due === "today")}>
        Due today
      </Link>
      <Link to="/activity?due=overdue" className={cls(path === "/activity" && due === "overdue")}>
        Overdue follow-ups
      </Link>
      {isManager(me.role) && (
        <Link to="/activity/reps" className={cls(path === "/activity/reps")}>
          Per rep
        </Link>
      )}
    </nav>
  );
}

const FILTER_KEYS = ["q", "ownerId", "status", "due"] as const;

export function ContactsPage() {
  const me = useMe();
  const manager = isManager(me.role);
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? "";
  const [q, setQ] = useState(get("q"));
  const dq = useDebounced(q.trim(), 400);

  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  useEffect(() => set("q", dq), [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-sync the box when the URL's q changes from outside (tab links, back/forward).
  const urlQ = get("q");
  useEffect(() => {
    if (urlQ !== dq) setQ(urlQ);
  }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const filters = { q: get("q"), ownerId: manager ? get("ownerId") : "", status: get("status"), due: get("due") };
  const activeCount = [filters.ownerId, filters.status, filters.due].filter(Boolean).length;

  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });
  const contacts = useInfiniteQuery({
    queryKey: ["contacts", filters],
    queryFn: ({ pageParam }) => api<ContactPage>(`/api/contacts${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = contacts.data?.pages.flatMap((p) => p.items) ?? [];
  const loadMoreError = contacts.isFetchNextPageError ? contacts.error : null;
  const loadMore = () => void contacts.fetchNextPage();
  const now = Date.now();

  const clear = () => {
    setQ("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const followUp = (iso: string | null) =>
    iso ? <span className={isOverdue(iso, now) ? "font-medium text-red-600 dark:text-red-400" : ""}>{formatShortWhen(iso)}{isOverdue(iso, now) ? " · overdue" : ""}</span> : "—";

  return (
    <>
      <PageHeader
        title="Activity Tracker"
        subtitle={filters.due === "overdue" ? "Follow-ups that are past due" : filters.due === "today" ? "Follow-ups due today (IST)" : "Every number your team has called, messaged or noted"}
      />
      <TrackerTabs />

      <div className="card mb-4 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="label" htmlFor="c-q">
              Search
            </label>
            <input id="c-q" type="search" className="input" placeholder="Name, company or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {manager && (
            <div>
              <label className="label" htmlFor="c-owner">
                Owner
              </label>
              <select id="c-owner" className="input" value={get("ownerId")} onChange={(e) => set("ownerId", e.target.value)}>
                <option value="">Everyone</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {personName(u)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="c-status">
              Status
            </label>
            <select id="c-status" className="input" value={get("status")} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any status</option>
              {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CONTACT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-due">
              Follow-up
            </label>
            <select id="c-due" className="input" value={get("due")} onChange={(e) => set("due", e.target.value)}>
              <option value="">Any time</option>
              <option value="today">Due today</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
        </div>
        {(activeCount > 0 || filters.q) && (
          <button type="button" className="btn-ghost mt-2" onClick={clear}>
            Clear all
          </button>
        )}
      </div>

      {contacts.isPending ? (
        <Spinner label="Loading contacts" />
      ) : contacts.isError ? (
        <ErrorBox error={contacts.error} onRetry={() => void contacts.refetch()} />
      ) : items.length === 0 ? (
        <Empty>
          {filters.due === "overdue"
            ? "No overdue follow-ups."
            : activeCount || filters.q
              ? "No contacts match these filters."
              : "No contacts yet. A number appears here the first time a rep calls, messages or notes it in the app."}
        </Empty>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/activity/contacts/${c.id}`} className="card block p-3 active:bg-slate-50 dark:active:bg-slate-800">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.name || c.phoneE164}</div>
                      <div className="truncate text-sm text-slate-500">{[c.name ? c.phoneE164 : null, c.company].filter(Boolean).join(" · ")}</div>
                    </div>
                    <ContactStatusBadge status={c.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
                    {c.nextFollowUpAt && <span>Follow up {followUp(c.nextFollowUpAt)}</span>}
                    {c.lastActivityAt && <span>Last {formatShortWhen(c.lastActivityAt)}</span>}
                    {c.owner && <span className="truncate">{personName(c.owner)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <tr>
                  {["Phone", "Name", "Company", "Owner", "Status", "Last activity", "Next follow-up"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link to={`/activity/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                        {c.phoneE164}
                      </Link>
                    </td>
                    <td className="max-w-48 truncate px-4 py-3">{c.name || "—"}</td>
                    <td className="max-w-48 truncate px-4 py-3">{c.company || "—"}</td>
                    <td className="max-w-40 truncate px-4 py-3">{c.owner ? personName(c.owner) : "—"}</td>
                    <td className="px-4 py-3">
                      <ContactStatusBadge status={c.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{c.lastActivityAt ? formatShortWhen(c.lastActivityAt) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">{followUp(c.nextFollowUpAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-center">
            {contacts.hasNextPage ? (
              <button type="button" className="btn-outline" disabled={contacts.isFetchingNextPage} onClick={loadMore}>
                {contacts.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : (
              <p className="text-xs text-slate-500">
                {items.length} contact{items.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {loadMoreError && <ErrorBox error={loadMoreError} onRetry={loadMore} />}
        </>
      )}
    </>
  );
}
