import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ClientImportResult, type ClientNumber, type PrivacySettings } from "../api";
import { formatWhen } from "../format";
import { ConfirmDialog, Empty, ErrorBox, Spinner, Toggle } from "../ui";

/** Audio retention (off = keep forever) and PII masking (off). Admin only. */
export function PrivacyPanel() {
  const settings = useQuery({ queryKey: ["privacy"], queryFn: () => api<PrivacySettings>("/api/settings/privacy") });
  return (
    <section className="card mt-4 p-4 sm:p-6">
      <h2 className="font-semibold">Privacy</h2>
      {settings.isPending ? (
        <Spinner label="Loading privacy settings" />
      ) : settings.isError ? (
        <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <PrivacyForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </section>
  );
}

function PrivacyForm({ initial }: { initial: PrivacySettings }) {
  const qc = useQueryClient();
  const [keepForever, setKeepForever] = useState(initial.retentionMonths === null);
  const [months, setMonths] = useState(String(initial.retentionMonths ?? 24));
  const [maskPii, setMaskPii] = useState(initial.maskPii);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const monthsOk = keepForever || (/^\d+$/.test(months) && Number(months) >= 1 && Number(months) <= 240);
  const next: PrivacySettings = { retentionMonths: keepForever ? null : Number(months), maskPii };
  const dirty = JSON.stringify(next) !== JSON.stringify(initial);
  // Turning deletion on (or shortening it) deletes audio: ask first.
  const deletesMore = next.retentionMonths !== null && (initial.retentionMonths === null || next.retentionMonths < initial.retentionMonths);

  const save = useMutation({
    mutationFn: () => api<PrivacySettings>("/api/settings/privacy", { method: "PUT", body: next }),
    onSuccess: (data) => {
      setSaved(true);
      qc.setQueryData(["privacy"], data);
    },
  });
  const submit = () => (deletesMore ? setConfirm(true) : save.mutate());

  return (
    <form
      className="mt-2 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && monthsOk) submit();
      }}
    >
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        <Toggle
          label="Keep recordings forever"
          hint="Turn off to delete audio files of calls older than the months below, once a day. Transcripts are kept."
          checked={keepForever}
          onChange={(v) => {
            setSaved(false);
            setKeepForever(v);
          }}
        />
        {!keepForever && (
          <div className="max-w-xs py-2">
            <label className="label" htmlFor="p-months">
              Delete audio older than (months)
            </label>
            <input id="p-months" inputMode="numeric" className="input" value={months} aria-invalid={!monthsOk} onChange={(e) => {
              setSaved(false);
              setMonths(e.target.value);
            }} />
            <p className={`hint ${monthsOk ? "" : "text-red-600"}`}>1 to 240. Deleted audio can't be recovered.</p>
          </div>
        )}
        <Toggle
          label="Mask Aadhaar and card numbers in new transcripts"
          hint="Replaces them with the last 4 digits before the transcript is stored. Existing transcripts are not changed. PAN and GST numbers are kept."
          checked={maskPii}
          onChange={(v) => {
            setSaved(false);
            setMaskPii(v);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={!dirty || !monthsOk || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700 dark:text-emerald-400">Saved.</span>}
          {save.error && <span className="text-red-600 dark:text-red-400">{save.error.message}</span>}
        </span>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete old recordings?"
        body={`Audio files of calls older than ${next.retentionMonths} months will be deleted permanently in the next daily run. Transcripts stay.`}
        confirmLabel="Turn on deletion"
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          save.mutate();
        }}
      />
    </form>
  );
}

/** Business-only mode: numbers that always upload, even when saved as a personal contact. */
export function ClientListPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["client-numbers"], queryFn: () => api<{ items: ClientNumber[]; count: number }>("/api/client-numbers") });
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [filter, setFilter] = useState("");
  const [imported, setImported] = useState<ClientImportResult | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["client-numbers"] });

  const add = useMutation({
    mutationFn: () => api<ClientNumber>("/api/client-numbers", { method: "POST", body: { number, label: label || undefined } }),
    onSuccess: () => {
      setNumber("");
      setLabel("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/client-numbers/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => api<ClientImportResult>("/api/client-numbers/import", { method: "POST", body: { csv: await file.text() } }),
    onSuccess: (r) => {
      setImported(r);
      refresh();
    },
  });

  const items = (list.data?.items ?? []).filter((i) => {
    const f = filter.trim().toLowerCase();
    return !f || i.raw.includes(f) || (i.label ?? "").toLowerCase().includes(f);
  });

  return (
    <section className="card mt-4 p-4 sm:p-6">
      <h2 className="font-semibold">Client list</h2>
      <p className="hint">
        With "Business calls only" on, phones skip calls with numbers saved as personal contacts, unless the number is on this list. Phones only download
        hashed numbers.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (number.trim()) add.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="cn-number">
            Phone number
          </label>
          <input id="cn-number" className="input" inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cn-label">
            Label (optional)
          </label>
          <input id="cn-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" disabled={!number.trim() || add.isPending}>
          Add
        </button>
        <label className="btn-outline cursor-pointer">
          {importCsv.isPending ? "Importing…" : "Import CSV"}
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importCsv.mutate(f);
              e.target.value = "";
            }}
          />
        </label>
      </form>
      <p className="hint">CSV: one number per line, optional label after a comma. A header row is skipped.</p>
      <div aria-live="polite" className="text-sm">
        {add.error && <p className="text-red-600 dark:text-red-400">{add.error.message}</p>}
        {importCsv.error && <p className="text-red-600 dark:text-red-400">{importCsv.error.message}</p>}
        {remove.error && <p className="text-red-600 dark:text-red-400">{remove.error.message}</p>}
        {imported && (
          <p className="text-emerald-700 dark:text-emerald-400">
            Imported: {imported.added} added, {imported.updated} labels updated, {imported.rejected} lines skipped
            {imported.rejectedSample.length > 0 && ` (e.g. ${imported.rejectedSample.slice(0, 3).join("; ")})`}.
          </p>
        )}
      </div>

      {list.isPending ? (
        <Spinner label="Loading client list" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.count === 0 ? (
        <div className="mt-3">
          <Empty>No client numbers yet.</Empty>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label htmlFor="cn-filter" className="sr-only">
              Filter client numbers
            </label>
            <input id="cn-filter" type="search" className="input sm:max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="text-sm text-slate-500">{list.data.count} numbers</span>
          </div>
          <ul className="mt-2 max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {items.slice(0, 500).map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-mono">{i.raw}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{i.label}</span>
                <span className="hidden text-xs text-slate-400 sm:inline">{formatWhen(i.createdAt)}</span>
                <button type="button" className="btn-ghost text-red-700 dark:text-red-300" disabled={remove.isPending} onClick={() => remove.mutate(i.id)} aria-label={`Remove ${i.raw}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {items.length > 500 && <p className="hint">Showing 500 of {items.length}. Use the filter to find a number.</p>}
        </>
      )}
    </section>
  );
}
