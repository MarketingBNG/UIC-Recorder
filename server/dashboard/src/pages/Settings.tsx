import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type DeviceConfig, type Settings } from "../api";
import { ErrorBox, PageHeader, Spinner, Toggle } from "../ui";

export function SettingsPage() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/settings") });
  return (
    <>
      <PageHeader title="Server settings" subtitle="Applied to every phone. Excluded numbers are set per user on the Users page." />
      {settings.isPending ? (
        <Spinner label="Loading settings" />
      ) : settings.isError ? (
        <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <>
          <DeviceConfigForm initial={settings.data.deviceConfig} />
          <section className="card mt-4 p-4">
            <h2 className="font-semibold">Published app</h2>
            {settings.data.latestApp ? (
              <p className="mt-1 break-all text-sm text-slate-600 dark:text-slate-400">
                {settings.data.latestApp.versionName} ({settings.data.latestApp.versionCode}) · {settings.data.latestApp.fileName}
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-500">No app version published yet.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function DeviceConfigForm({ initial }: { initial: DeviceConfig }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...initial, folders: initial.recorderFolders.join("\n"), cutoff: String(initial.backlogCutoffDays) });
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const folderList = form.folders
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const cutoff = Number(form.cutoff);
  const foldersOk = folderList.length <= 50 && folderList.every((f) => f.length <= 200);
  const cutoffOk = /^\d+$/.test(form.cutoff) && cutoff >= 0 && cutoff <= 3650;
  const config: DeviceConfig = {
    recorderFolders: folderList,
    liveNetwork: form.liveNetwork,
    backlogEnabled: form.backlogEnabled,
    backlogCutoffDays: cutoff,
    maxParallelUploads: form.maxParallelUploads,
    compressAudio: form.compressAudio,
    businessOnly: form.businessOnly,
  };
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => api<DeviceConfig>("/api/settings/device-config", { method: "PUT", body: config }),
    onSuccess: (data) => {
      setSaved(true);
      qc.setQueryData<Settings>(["settings"], (s) => (s ? { ...s, deviceConfig: data } : s));
    },
  });

  return (
    <form
      className="card space-y-5 p-4 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (foldersOk && cutoffOk && dirty) save.mutate();
      }}
    >
      <h2 className="font-semibold">Device sync settings</h2>
      <div>
        <label className="label" htmlFor="s-folders">
          Recorder folders, one per line
        </label>
        <textarea id="s-folders" rows={8} className="input py-2 font-mono" value={form.folders} onChange={(e) => set("folders", e.target.value)} aria-describedby="s-folders-hint" />
        <p id="s-folders-hint" className={`hint ${foldersOk ? "" : "text-red-600"}`}>
          Paths under internal storage, such as Recordings/Call. {folderList.length}/50
        </p>
      </div>

      <fieldset>
        <legend className="label">Live uploads network</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["any", "Any network"],
              ["wifi", "Wi-Fi only"],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 dark:border-slate-700 dark:has-[:checked]:bg-slate-800">
              <input type="radio" name="net" className="accent-brand-600" checked={form.liveNetwork === v} onChange={() => set("liveNetwork", v)} />
              {l}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        <Toggle label="Upload old recordings (backlog)" hint="Recordings made before the app was installed." checked={form.backlogEnabled} onChange={(v) => set("backlogEnabled", v)} />
        <Toggle label="Compress audio before upload" hint="Smaller files, less mobile data." checked={form.compressAudio} onChange={(v) => set("compressAudio", v)} />
        <Toggle label="Business calls only" hint="Skip numbers saved as personal contacts." checked={form.businessOnly} onChange={(v) => set("businessOnly", v)} />
      </div>

      <div className="max-w-xs">
        <label className="label" htmlFor="s-cutoff">
          Backlog cutoff (days)
        </label>
        <input id="s-cutoff" inputMode="numeric" className="input" value={form.cutoff} onChange={(e) => set("cutoff", e.target.value)} aria-describedby="s-cutoff-hint" aria-invalid={!cutoffOk} />
        <p id="s-cutoff-hint" className={`hint ${cutoffOk ? "" : "text-red-600"}`}>
          Skip recordings older than this. 0 to 3650.
        </p>
      </div>

      <fieldset>
        <legend className="label">Max parallel uploads</legend>
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((n) => (
            <label key={n} className="grid size-10 cursor-pointer place-items-center rounded-lg border border-slate-300 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-600 has-[:checked]:text-white dark:border-slate-700">
              <input type="radio" name="par" className="sr-only" checked={form.maxParallelUploads === n} onChange={() => set("maxParallelUploads", n)} />
              {n}
            </label>
          ))}
        </div>
        <p className="hint">Low-RAM phones always upload one at a time.</p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <button type="submit" className="btn-primary" disabled={!dirty || !foldersOk || !cutoffOk || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.reset();
            setForm({ ...initial, folders: initial.recorderFolders.join("\n"), cutoff: String(initial.backlogCutoffDays) });
          }}
        >
          Discard changes
        </button>
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700 dark:text-emerald-400">Saved. Phones pick this up on their next sync.</span>}
          {save.error && <span className="text-red-600 dark:text-red-400">{save.error.message}</span>}
        </span>
      </div>
    </form>
  );
}
