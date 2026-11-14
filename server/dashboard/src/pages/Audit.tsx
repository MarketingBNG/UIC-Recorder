import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type AuditAction, type AuditEntry, type AuditPage as Page } from "../api";
import { formatWhen } from "../format";
import { Badge, Empty, ErrorBox, PageHeader, Spinner } from "../ui";

export const AUDIT_LABELS: Record<AuditAction, string> = {
  PLAY: "Played",
  DOWNLOAD: "Downloaded",
  SEARCH: "Searched",
  DELETE: "Deleted call",
  USER_CHANGE: "User changed",
  DEVICE_REVOKE: "Phone signed out",
  SETTINGS_CHANGE: "Settings changed",
  CLIENT_LIST_CHANGE: "Client list changed",
  RETENTION_DELETE: "Retention deleted audio",
  EXPORT: "Exported calls (CSV)",
  CRM_SYNC: "Zoho CRM sync",
};

/** One-line summary of the detail JSON (same wording as the Android Audit screen). */
export function auditSummary(e: Pick<AuditEntry, "action" | "detail">): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case "SEARCH":
      return typeof d["q"] === "string" ? `"${d["q"]}"` : "";
    case "EXPORT":
      return `${d["rows"] ?? 0} calls`;
    case "RETENTION_DELETE":
      return `${d["deleted"] ?? 0} audio files older than ${d["retentionMonths"] ?? "?"} months`;
    case "CLIENT_LIST_CHANGE":
      return Object.entries(d)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
    default:
      return e.detail ? JSON.stringify(e.detail).slice(0, 160) : "";
  }
}

export function AuditPage() {
  const [action, setAction] = useState<AuditAction | "">("");
  const log = useInfiniteQuery({
    queryKey: ["audit", action],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "50" });
      if (action) p.set("action", action);
      if (pageParam) p.set("cursor", pageParam);
      return api<Page>(`/api/audit?${p}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who played, downloaded, searched or changed what. Newest first." />
      <div className="mb-4 max-w-xs">
        <label className="label" htmlFor="audit-action">
          Action
        </label>
        <select id="audit-action" className="input" value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
          <option value="">All actions</option>
          {(Object.keys(AUDIT_LABELS) as AuditAction[]).map((a) => (
            <option key={a} value={a}>
              {AUDIT_LABELS[a]}
            </option>
          ))}
        </select>
      </div>
      {log.isPending ? (
        <Spinner label="Loading audit log" />
      ) : log.isError && items.length === 0 ? (
        <ErrorBox error={log.error} onRetry={() => void log.refetch()} />
      ) : items.length === 0 ? (
        <Empty>No entries.</Empty>
      ) : (
        <>
          <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-sm">
                <span className="w-40 shrink-0 text-slate-500 tabular-nums">{formatWhen(e.createdAt)}</span>
                <Badge tone={e.action === "DELETE" || e.action === "RETENTION_DELETE" ? "red" : e.action === "DOWNLOAD" ? "amber" : "gray"}>
                  {AUDIT_LABELS[e.action as AuditAction] ?? e.action}
                </Badge>
                <span className="font-medium">{e.user ? e.user.name || e.user.email : "System"}</span>
                {e.callId && (
                  <Link className="text-brand-700 underline dark:text-brand-300" to={`/calls/${e.callId}`}>
                    Call
                  </Link>
                )}
                <span className="min-w-0 flex-1 break-all text-slate-500">{auditSummary(e)}</span>
              </li>
            ))}
          </ul>
          {log.hasNextPage && (
            <button type="button" className="btn-outline mt-4 w-full" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              {log.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
          {log.isFetchNextPageError && <ErrorBox error={log.error} />}
        </>
      )}
    </>
  );
}
