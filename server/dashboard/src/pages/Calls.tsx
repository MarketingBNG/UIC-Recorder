import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, isManager, qs, type CallPage, type CallStatus, type Direction, type User } from "../api";
import { useMe } from "../App";
import { DIRECTION_LABEL, STATUS_LABEL, formatDuration, formatShortWhen, personName } from "../format";
import { DirectionTag, Empty, ErrorBox, PageHeader, Spinner, StatusBadge } from "../ui";

const FILTER_KEYS = ["q", "phone", "userId", "direction", "status", "from", "to"] as const;

/** yyyy-mm-dd from a date input, read in the viewer's time zone. */
function dayBoundary(day: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CallsPage() {
  const me = useMe();
  const manager = isManager(me.role);
  // Filters live in the URL so Back from a call returns to the same list.
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? "";
  const [q, setQ] = useState(get("q"));
  const [phone, setPhone] = useState(get("phone"));
  const dq = useDebounced(q.trim(), 400);
  const dphone = useDebounced(phone.trim(), 400);
  const [showFilters, setShowFilters] = useState(() => FILTER_KEYS.some((k) => k !== "q" && params.get(k)));

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
  useEffect(() => set("phone", dphone), [dphone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Like the Android app: a number-like search (3+ chars) searches by phone, not transcript.
  const search = get("q").trim();
  const isPhone = search.length >= 3 && /^[+\d][\d\s()\-]*$/.test(search);
  const filters = {
    q: isPhone ? "" : search,
    phone: isPhone ? search.replace(/[^\d+]/g, "") : get("phone"),
    userId: manager ? get("userId") : "",
    direction: get("direction"),
    status: get("status"),
    from: dayBoundary(get("from"), false),
    to: dayBoundary(get("to"), true),
  };
  const activeCount = [filters.phone, filters.userId, filters.direction, filters.status, get("from"), get("to")].filter(Boolean).length;

  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });

  const calls = useInfiniteQuery({
    queryKey: ["calls", filters],
    queryFn: ({ pageParam }) => api<CallPage>(`/api/calls${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  const loadMoreError = calls.isFetchNextPageError ? calls.error : null;
  const loadMore = () => void calls.fetchNextPage();

  const clear = () => {
    setQ("");
    setPhone("");
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <PageHeader title="Calls" subtitle={me.role === "ADMIN" ? "All recorded calls" : me.role === "MANAGER" && me.team ? `Calls from team ${me.team}` : "Your recorded calls"} />

      <div className="card mb-4 p-3 sm:p-4">
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="q">
            Search transcripts or phone
          </label>
          <input id="q" type="search" className="input" placeholder="Search transcripts or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="btn-outline shrink-0" aria-expanded={showFilters} aria-controls="filters" onClick={() => setShowFilters((s) => !s)}>
            Filters{activeCount ? ` (${activeCount})` : ""}
          </button>
        </div>
        {showFilters && (
          <div id="filters" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="label" htmlFor="f-phone">
                Phone number
              </label>
              <input id="f-phone" className="input" inputMode="tel" placeholder="Any part of the number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            {manager && (
              <div>
                <label className="label" htmlFor="f-user">
                  Person
                </label>
                <select id="f-user" className="input" value={get("userId")} onChange={(e) => set("userId", e.target.value)}>
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
              <label className="label" htmlFor="f-dir">
                Direction
              </label>
              <select id="f-dir" className="input" value={get("direction")} onChange={(e) => set("direction", e.target.value)}>
                <option value="">All directions</option>
                {(Object.keys(DIRECTION_LABEL) as Direction[]).map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABEL[d]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-status">
                Status
              </label>
              <select id="f-status" className="input" value={get("status")} onChange={(e) => set("status", e.target.value)}>
                <option value="">Any status</option>
                {(Object.keys(STATUS_LABEL) as CallStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-from">
                From
              </label>
              <input id="f-from" type="date" className="input" value={get("from")} max={get("to") || undefined} onChange={(e) => set("from", e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="f-to">
                To
              </label>
              <input id="f-to" type="date" className="input" value={get("to")} min={get("from") || undefined} onChange={(e) => set("to", e.target.value)} />
            </div>
            <div className="flex items-end">
              <button type="button" className="btn-ghost" onClick={clear}>
                Clear all
              </button>
            </div>
          </div>
        )}
      </div>

      {calls.isPending ? (
        <Spinner label="Loading calls" />
      ) : calls.isError ? (
        <ErrorBox error={calls.error} onRetry={() => void calls.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{activeCount || filters.q ? "No calls match these filters." : "No calls yet. They appear here once the phone app uploads them."}</Empty>
      ) : (
        <>
          {/* Phones: one card per call */}
          <ul className="space-y-2 md:hidden">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/calls/${c.id}`} className="card block p-3 active:bg-slate-50 dark:active:bg-slate-800">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.contactName || c.phoneE164 || c.phoneRaw || "Unknown number"}</div>
                      {c.contactName && <div className="truncate text-sm text-slate-500">{c.phoneE164 || c.phoneRaw}</div>}
                    </div>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
                    <DirectionTag direction={c.direction} />
                    <span>{formatShortWhen(c.startedAt)}</span>
                    <span>{formatDuration(c.durationS)}</span>
                    {manager && <span className="truncate">{personName(c.user)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Larger screens: table */}
          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Contact
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Direction
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Duration
                  </th>
                  {manager && (
                    <th scope="col" className="px-4 py-3 font-medium">
                      Person
                    </th>
                  )}
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <Link to={`/calls/${c.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                        {c.contactName || c.phoneE164 || c.phoneRaw || "Unknown number"}
                      </Link>
                      {c.contactName && <div className="text-xs text-slate-500">{c.phoneE164 || c.phoneRaw}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <DirectionTag direction={c.direction} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{formatShortWhen(c.startedAt)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatDuration(c.durationS)}</td>
                    {manager && <td className="max-w-48 truncate px-4 py-3">{personName(c.user)}</td>}
                    <td className="px-4 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-center">
            {calls.hasNextPage ? (
              <button type="button" className="btn-outline" disabled={calls.isFetchingNextPage} onClick={loadMore}>
                {calls.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : (
              <p className="text-xs text-slate-500">
                {items.length} call{items.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {loadMoreError && <ErrorBox error={loadMoreError} onRetry={loadMore} />}
        </>
      )}
    </>
  );
}
