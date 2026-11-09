import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useState } from "react";
import { api, qs, type RepStats } from "../api";
import { useMe } from "../App";
import { formatDuration, istDay, istDayBoundary, personName } from "../format";
import { Empty, ErrorBox, PageHeader, Spinner } from "../ui";
import { TrackerTabs } from "./Contacts";

export function RepsPage() {
  const me = useMe();
  const today = istDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const range = { from: istDayBoundary(from, false), to: istDayBoundary(to || from, true) };

  const reps = useQuery({
    queryKey: ["activity-reps", range],
    queryFn: () => api<{ items: RepStats[] }>(`/api/activity/reps${qs(range)}`),
  });
  const items = reps.data?.items ?? [];
  const cols = ["Rep", "Calls made", "Answered", "Talk time", "WhatsApp", "Due today", "Overdue"];

  return (
    <>
      <PageHeader
        title="Activity Tracker"
        subtitle={me.role === "MANAGER" && me.team ? `Rep activity for team ${me.team}` : "Rep activity"}
      />
      <TrackerTabs />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3 sm:p-4">
        <div>
          <label className="label" htmlFor="r-from">
            From (IST)
          </label>
          <input id="r-from" type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value || today)} />
        </div>
        <div>
          <label className="label" htmlFor="r-to">
            To (IST)
          </label>
          <input id="r-to" type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value || from)} />
        </div>
        {(from !== today || to !== today) && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setFrom(today);
              setTo(today);
            }}
          >
            Today
          </button>
        )}
        <p className="hint w-full">Due today and overdue count each rep's own contacts and ignore the date range.</p>
      </div>

      {reps.isPending ? (
        <Spinner label="Loading rep activity" />
      ) : reps.isError ? (
        <ErrorBox error={reps.error} onRetry={() => void reps.refetch()} />
      ) : items.length === 0 ? (
        <Empty>No reps to show.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <tr>
                {cols.map((h, i) => (
                  <th key={h} scope="col" className={`whitespace-nowrap px-4 py-3 font-medium ${i ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((r) => (
                <tr key={r.user.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <th scope="row" className="max-w-48 truncate px-4 py-3 font-medium">
                    {personName(r.user)}
                  </th>
                  <td className="px-4 py-3 text-right tabular-nums">{r.callsMade}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.answered}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatDuration(r.talkTimeS)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.whatsapp}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <Link to={`/activity${qs({ ownerId: r.user.id, due: "today" })}`} className="text-brand-700 hover:underline dark:text-brand-100">
                      {r.followUpsDueToday}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <Link
                      to={`/activity${qs({ ownerId: r.user.id, due: "overdue" })}`}
                      className={r.overdue ? "font-medium text-red-600 hover:underline dark:text-red-400" : "text-brand-700 hover:underline dark:text-brand-100"}
                    >
                      {r.overdue}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
