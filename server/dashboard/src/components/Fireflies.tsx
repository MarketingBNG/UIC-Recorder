import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type FirefliesSettingsPatch, type FirefliesUsage } from "../api";
import { useMe } from "../App";
import { formatWhen } from "../format";
import { Badge, ConfirmDialog, ErrorBox, Spinner, Toggle } from "../ui";

const KEY = ["fireflies"];
const useUsage = () => useQuery({ queryKey: KEY, queryFn: () => api<FirefliesUsage>("/api/fireflies/usage"), refetchInterval: 60_000 });

type Level = "info" | "warning" | "error";
const LEVEL_CLS: Record<Level, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  error: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
};

export function firefliesAlerts(u: FirefliesUsage): { level: Level; text: string }[] {
  const out: { level: Level; text: string }[] = [];
  if (u.blocked) {
    out.push({
      level: "error",
      text: `Fireflies is blocked until ${formatWhen(u.blockedUntil)}${u.lastError ? `: ${u.lastError}` : ""}`,
    });
  }
  if (u.pct >= 100) out.push({ level: "error", text: `Fireflies budget used up: ${u.pct}% of ${u.budgetMinutes} min this month.` });
  else if (u.pct >= 80) out.push({ level: "warning", text: `Fireflies budget at ${u.pct}% of ${u.budgetMinutes} min this month.` });
  else if (u.pct >= 50) out.push({ level: "info", text: `Fireflies budget at ${u.pct}% of ${u.budgetMinutes} min this month.` });
  if (u.enabled && u.backlogSent >= u.approvedBacklogCount) {
    out.push({
      level: "warning",
      text: `Backlog paused after ${u.approvedBacklogCount} calls - check Fireflies billing, then raise the limit.`,
    });
  }
  return out;
}

/** Shown in the app shell for managers and admins on every page. */
export function FirefliesBanner() {
  const me = useMe();
  const usage = useUsage();
  if (!usage.data) return null;
  const alerts = firefliesAlerts(usage.data);
  if (alerts.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {alerts.map((a) => (
        <div key={a.text} role={a.level === "info" ? "status" : "alert"} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm ${LEVEL_CLS[a.level]}`}>
          <span className="min-w-0 break-words">{a.text}</span>
          <Link to="/health#fireflies" className="font-medium underline">
            {me.role === "ADMIN" ? "Manage" : "Details"}
          </Link>
        </div>
      ))}
    </div>
  );
}

/** Usage for managers; the settings form and "Clear block" for admins. */
export function FirefliesPanel() {
  const me = useMe();
  const usage = useUsage();
  const [saved, setSaved] = useState(false);
  return (
    <section id="fireflies" className="card mb-4 scroll-mt-20 p-4 sm:p-6">
      {usage.isPending ? (
        <Spinner label="Loading Fireflies usage" />
      ) : usage.isError ? (
        <ErrorBox error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <Usage u={usage.data} />
          {me.role === "ADMIN" && <AdminForm key={formKey(usage.data)} u={usage.data} saved={saved} setSaved={setSaved} />}
        </>
      )}
    </section>
  );
}

const formKey = (u: FirefliesUsage) => [u.enabled, u.budgetMinutes, u.liveReservePct, u.approvedBacklogCount, u.deleteAfterFetch].join("|");

function Usage({ u }: { u: FirefliesUsage }) {
  const total = u.usedMinutes + u.reservedMinutes;
  const pctBar = Math.min(100, u.pct);
  const usedBar = u.budgetMinutes > 0 ? Math.min(100, (u.usedMinutes / u.budgetMinutes) * 100) : 100;
  const barTone = u.pct >= 100 ? "bg-red-600" : u.pct >= 80 ? "bg-amber-500" : "bg-brand-600";
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Fireflies transcription · {u.month}</h2>
        <div className="flex flex-wrap gap-1">
          {u.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Disabled</Badge>}
          {u.blocked && <Badge tone="red">Blocked</Badge>}
          {u.waitingBudgetJobs > 0 && <Badge tone="amber">{u.waitingBudgetJobs} waiting for budget</Badge>}
        </div>
      </div>
      <div className="mt-3 flex items-baseline justify-between text-sm">
        <span>
          <span className="text-xl font-semibold tabular-nums">{total}</span> / {u.budgetMinutes} min
        </span>
        <span className="font-medium tabular-nums">{u.pct}% used</span>
      </div>
      <div
        className="relative mt-2 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="progressbar"
        aria-label="Fireflies minutes used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctBar}
      >
        <div className={`absolute inset-y-0 left-0 opacity-40 ${barTone}`} style={{ width: `${pctBar}%` }} />
        <div className={`absolute inset-y-0 left-0 ${barTone}`} style={{ width: `${usedBar}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-slate-500">Used</dt>
        <dd className="tabular-nums">{u.usedMinutes} min</dd>
        <dt className="text-slate-500">Reserved</dt>
        <dd className="tabular-nums">{u.reservedMinutes} min</dd>
        <dt className="text-slate-500">Live reserve</dt>
        <dd className="tabular-nums">{u.liveReservePct}%</dd>
        <dt className="text-slate-500">Backlog sent</dt>
        <dd className={`tabular-nums ${u.backlogSent >= u.approvedBacklogCount ? "font-medium text-amber-700 dark:text-amber-300" : ""}`}>
          {u.backlogSent} of {u.approvedBacklogCount} approved
        </dd>
        <dt className="text-slate-500">Delete after fetch</dt>
        <dd>{u.deleteAfterFetch ? "Yes" : "No"}</dd>
        {u.blocked && (
          <>
            <dt className="text-slate-500">Blocked until</dt>
            <dd>{formatWhen(u.blockedUntil)}</dd>
          </>
        )}
      </dl>
      {u.lastError && (
        <p className="mt-3 break-words text-sm text-slate-600 dark:text-slate-400">
          Last error{u.lastErrorAt ? ` (${formatWhen(u.lastErrorAt)})` : ""}: {u.lastError}
        </p>
      )}
    </div>
  );
}

function AdminForm({ u, saved, setSaved }: { u: FirefliesUsage; saved: boolean; setSaved: (v: boolean) => void }) {
  const qc = useQueryClient();
  const init = {
    enabled: u.enabled,
    deleteAfterFetch: u.deleteAfterFetch,
    budget: String(u.budgetMinutes),
    reserve: String(u.liveReservePct),
    approved: String(u.approvedBacklogCount),
  };
  const [form, setForm] = useState(init);
  const [confirmClear, setConfirmClear] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const int = (s: string, max: number) => /^\d+$/.test(s.trim()) && Number(s) <= max;
  const budgetOk = int(form.budget, 1_000_000);
  const reserveOk = /^\d+(\.\d+)?$/.test(form.reserve.trim()) && Number(form.reserve) <= 100;
  const approvedOk = int(form.approved, 10_000_000);
  const valid = budgetOk && reserveOk && approvedOk;

  const patch: FirefliesSettingsPatch = {};
  if (form.enabled !== u.enabled) patch.enabled = form.enabled;
  if (form.deleteAfterFetch !== u.deleteAfterFetch) patch.deleteAfterFetch = form.deleteAfterFetch;
  if (budgetOk && Number(form.budget) !== u.budgetMinutes) patch.budgetMinutes = Number(form.budget);
  if (reserveOk && Number(form.reserve) !== u.liveReservePct) patch.liveReservePct = Number(form.reserve);
  if (approvedOk && Number(form.approved) !== u.approvedBacklogCount) patch.approvedBacklogCount = Number(form.approved);
  const dirty = Object.keys(patch).length > 0;

  const onSaved = (data: FirefliesUsage) => {
    qc.setQueryData(KEY, data);
    void qc.invalidateQueries({ queryKey: ["stats"] });
  };
  const save = useMutation({
    mutationFn: (body: FirefliesSettingsPatch) => api<FirefliesUsage>("/api/settings/fireflies", { method: "PUT", body }),
    onSuccess: (data) => {
      setSaved(true);
      onSaved(data);
    },
  });
  const clear = useMutation({
    mutationFn: () => api<FirefliesUsage>("/api/settings/fireflies", { method: "PUT", body: { clearBlock: true } }),
    onSuccess: (data) => {
      setConfirmClear(false);
      onSaved(data);
    },
  });

  return (
    <form
      className="mt-5 space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty) save.mutate(patch);
      }}
    >
      <h3 className="font-semibold">Fireflies settings</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="ff-budget">
            Monthly budget (minutes)
          </label>
          <input id="ff-budget" inputMode="numeric" className="input" value={form.budget} onChange={(e) => set("budget", e.target.value)} aria-invalid={!budgetOk} aria-describedby="ff-budget-hint" />
          <p id="ff-budget-hint" className={`hint ${budgetOk ? "" : "text-red-600 dark:text-red-400"}`}>
            Whole number, 0 to 1,000,000.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="ff-reserve">
            Live reserve (%)
          </label>
          <input id="ff-reserve" inputMode="decimal" className="input" value={form.reserve} onChange={(e) => set("reserve", e.target.value)} aria-invalid={!reserveOk} aria-describedby="ff-reserve-hint" />
          <p id="ff-reserve-hint" className={`hint ${reserveOk ? "" : "text-red-600 dark:text-red-400"}`}>
            0 to 100. Only live calls may use this share.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="ff-approved">
            Approved backlog calls
          </label>
          <div className="flex gap-2">
            <input id="ff-approved" inputMode="numeric" className="input" value={form.approved} onChange={(e) => set("approved", e.target.value)} aria-invalid={!approvedOk} aria-describedby="ff-approved-hint" />
            <button
              type="button"
              className="btn-outline shrink-0"
              disabled={!approvedOk}
              onClick={() => set("approved", String(Math.min(10_000_000, Number(form.approved) + 20)))}
            >
              +20
            </button>
          </div>
          <p id="ff-approved-hint" className={`hint ${approvedOk ? "" : "text-red-600 dark:text-red-400"}`}>
            Total imported calls allowed. {u.backlogSent} sent so far.
          </p>
        </div>
      </div>
      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        <Toggle checked={form.enabled} onChange={(v) => set("enabled", v)} label="Send calls to Fireflies" hint="When off, no new calls are sent." />
        <Toggle
          checked={form.deleteAfterFetch}
          onChange={(v) => set("deleteAfterFetch", v)}
          label="Delete from Fireflies after fetching"
          hint="Removes the meeting from Fireflies once the transcript is saved here."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <button type="submit" className="btn-primary" disabled={!dirty || !valid || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={(!dirty && valid) || save.isPending}
          onClick={() => {
            save.reset();
            setForm(init);
          }}
        >
          Discard changes
        </button>
        {u.blocked && (
          <button type="button" className="btn-outline text-red-700 dark:text-red-300" onClick={() => setConfirmClear(true)}>
            Clear block
          </button>
        )}
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700 dark:text-emerald-400">Saved.</span>}
          {save.error && <span className="text-red-600 dark:text-red-400">{save.error.message}</span>}
        </span>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear the Fireflies block?"
        body={
          <>
            Calls will be sent to Fireflies again right away. Only do this after fixing the cause in Fireflies (billing, plan or quota).
            {u.lastError && <span className="mt-2 block text-slate-500">Last error: {u.lastError}</span>}
          </>
        }
        confirmLabel="Clear block"
        busy={clear.isPending}
        error={clear.error}
        onConfirm={() => clear.mutate()}
        onClose={() => {
          setConfirmClear(false);
          clear.reset();
        }}
      />
    </form>
  );
}
