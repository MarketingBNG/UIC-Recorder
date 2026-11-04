import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CallStatus, type Device, type Stats } from "../api";
import { useMe } from "../App";
import { STATUS_LABEL, ago, jobStatusLabel, formatBytes, formatWhen, personName } from "../format";
import { FirefliesPanel } from "../components/Fireflies";
import { Badge, ConfirmDialog, Empty, ErrorBox, PageHeader, Spinner } from "../ui";

const STALE_MS = 24 * 3600_000;

export function HealthPage() {
  const me = useMe();
  const isAdmin = me.role === "ADMIN";
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/api/devices") });
  // Stats failing (e.g. disk probe) shouldn't hide the device list.
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/api/stats") });
  const [confirm, setConfirm] = useState<Device | null>(null);

  const revoke = useMutation({
    mutationFn: (d: Device) => api<void>(`/api/devices/${d.id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["devices"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  const now = Date.now();
  // Active devices first, revoked at the bottom; server order (last seen desc) otherwise.
  const sorted = devices.data ? [...devices.data].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt)) : [];

  return (
    <>
      <PageHeader
        title="Sync health"
        subtitle="Phones that upload recordings. A phone not seen for 24 hours is flagged."
        actions={
          <button
            type="button"
            className="btn-outline"
            disabled={devices.isFetching}
            onClick={() => {
              void devices.refetch();
              void stats.refetch();
            }}
          >
            {devices.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {stats.data && <StatsHeader s={stats.data} />}
      {stats.isError && <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">Server stats unavailable: {stats.error.message}</p>}

      <FirefliesPanel />

      {devices.isPending ? (
        <Spinner label="Loading devices" />
      ) : devices.isError ? (
        <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
      ) : sorted.length === 0 ? (
        <Empty>No devices have signed in yet.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {sorted.map((d) => {
            const stale = !d.revokedAt && (!d.lastSeenAt || now - new Date(d.lastSeenAt).getTime() > STALE_MS);
            return (
              <li key={d.id} className={`card p-4 ${d.revokedAt ? "opacity-60" : ""} ${stale ? "border-amber-300 dark:border-amber-800" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{personName(d.user)}</div>
                    <div className="truncate text-sm text-slate-500">
                      {d.model ?? "Unknown phone"}
                      {d.androidVersion ? ` · Android ${d.androidVersion}` : ""}
                      {d.appVersion ? ` · app ${d.appVersion}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {d.revokedAt ? <Badge tone="red">Revoked</Badge> : stale ? <Badge tone="amber">Not seen 24h+</Badge> : <Badge tone="green">OK</Badge>}
                    {!d.revokedAt && !d.permissionsOk && <Badge tone="red">Permissions missing</Badge>}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-slate-500">Last seen</dt>
                  <dd title={formatWhen(d.lastSeenAt)}>{ago(d.lastSeenAt, now)}</dd>
                  <dt className="text-slate-500">Last sync</dt>
                  <dd title={formatWhen(d.lastSyncAt)}>{ago(d.lastSyncAt, now)}</dd>
                  <dt className="text-slate-500">Waiting to upload</dt>
                  <dd className={d.pendingCount > 0 ? "font-medium text-amber-700 dark:text-amber-300" : ""}>{d.pendingCount}</dd>
                  <dt className="text-slate-500">Free space</dt>
                  <dd>{formatBytes(d.freeBytes)}</dd>
                  {d.revokedAt && (
                    <>
                      <dt className="text-slate-500">Revoked</dt>
                      <dd>{formatWhen(d.revokedAt)}</dd>
                    </>
                  )}
                </dl>
                {isAdmin && !d.revokedAt && (
                  <button type="button" className="btn-ghost mt-3 -ml-3 px-3 text-red-700 dark:text-red-300" onClick={() => setConfirm(d)}>
                    Revoke device
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Revoke device?"
        body={
          confirm && (
            <>
              {confirm.model ?? "This device"} ({personName(confirm.user)}) will be signed out and stop uploading until the user signs in again.
            </>
          )
        }
        confirmLabel="Revoke"
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => confirm && revoke.mutate(confirm)}
        onClose={() => {
          setConfirm(null);
          revoke.reset();
        }}
      />
    </>
  );
}

function StatsHeader({ s }: { s: Stats }) {
  const tile = (label: string, value: string | number, warn = false) => (
    <div className="card p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-300" : ""}`}>{value}</div>
    </div>
  );
  const jobsWaiting = (s.jobs["QUEUED"] ?? 0) + (s.jobs["RUNNING"] ?? 0) + (s.jobs["WAITING_BUDGET"] ?? 0);
  return (
    <div className="mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tile("Stale phones", s.staleDevices, s.staleDevices > 0)}
        {tile("Failed calls", s.calls.FAILED ?? 0, (s.calls.FAILED ?? 0) > 0)}
        {tile("Transcription queue", jobsWaiting)}
        {tile("Server disk used", `${s.disk.usedPct}%`, s.disk.usedPct >= 85)}
      </div>
      <details className="card p-3 text-sm">
        <summary className="cursor-pointer font-medium">Details</summary>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Calls by status</div>
            {(Object.keys(STATUS_LABEL) as CallStatus[]).map((k) => (
              <div key={k} className="flex justify-between">
                <span>{STATUS_LABEL[k]}</span>
                <span className="tabular-nums">{s.calls[k] ?? 0}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Jobs</div>
            {Object.keys(s.jobs).length === 0 && <div className="text-slate-500">None</div>}
            {Object.entries(s.jobs).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span>{jobStatusLabel(k)}</span>
                <span className="tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Disk</div>
            <div className="flex justify-between">
              <span>Free</span>
              <span>{formatBytes(s.disk.freeBytes)}</span>
            </div>
            <div className="flex justify-between">
              <span>Total</span>
              <span>{formatBytes(s.disk.totalBytes)}</span>
            </div>
            <meter className="mt-2 w-full" min={0} max={100} low={70} high={85} optimum={0} value={s.disk.usedPct} aria-label="Disk used" />
          </div>
        </div>
      </details>
    </div>
  );
}
