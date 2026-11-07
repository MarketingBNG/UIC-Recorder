import type { Db } from "../db.js";
import type { LocalStorage } from "../storage/local.js";
import { getPrivacySettings } from "./settings.js";

export const RETENTION_INTERVAL_MS = 24 * 3600_000;
const BATCH = 500;
const OPEN_JOB = { status: { in: ["QUEUED" as const, "RUNNING" as const, "WAITING_BUDGET" as const] } };

/** `months` calendar months before `now` (UTC), clamped to the last day of a shorter month. */
export function retentionCutoff(now: Date, months: number): Date {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Deletes audio files of calls that started before the retention cutoff; transcripts stay.
 * Does nothing while retentionMonths is null (the default). Calls with an open job of any kind are
 * skipped so a running transcription or compression never loses its file. One RETENTION_DELETE audit row per run.
 */
export async function runRetention(db: Db, storage: LocalStorage, now = new Date()): Promise<{ deleted: number; bytes: number } | null> {
  const { retentionMonths } = await getPrivacySettings(db);
  if (retentionMonths === null) return null;
  const cutoff = retentionCutoff(now, retentionMonths);
  let deleted = 0;
  let bytes = 0;
  let after: string | undefined;
  for (;;) {
    const calls = await db.call.findMany({
      where: {
        startedAt: { lt: cutoff },
        filePath: { not: null },
        status: { in: ["TRANSCRIBED", "FAILED"] },
        jobs: { none: OPEN_JOB },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, filePath: true, fileSize: true },
    });
    if (calls.length === 0) break;
    after = calls.at(-1)!.id;
    for (const c of calls) {
      // Clear the row first (guarded on the same path and still no open job), then remove the file:
      // a crash in between leaves an orphan file, never a row pointing at a missing file.
      const r = await db.call.updateMany({
        where: { id: c.id, filePath: c.filePath, jobs: { none: OPEN_JOB } },
        data: { filePath: null, fileSize: null, audioDeletedAt: now },
      });
      if (r.count === 0) continue;
      await storage.remove(c.filePath!).catch(() => {});
      deleted++;
      bytes += Number(c.fileSize ?? 0n);
    }
    if (calls.length < BATCH) break;
  }
  if (deleted > 0) {
    await db.auditLog.create({
      data: { action: "RETENTION_DELETE", detail: { deleted, bytes, retentionMonths, cutoff: cutoff.toISOString() } },
    });
  }
  return { deleted, bytes };
}

/** Daily retention run (first one a minute after start). Returns a stop function. */
export function startRetentionLoop(db: Db, storage: LocalStorage, onError: (err: unknown) => void, onDeleted: (r: { deleted: number; bytes: number }) => void) {
  const tick = () =>
    runRetention(db, storage)
      .then((r) => {
        if (r && r.deleted > 0) onDeleted(r);
      })
      .catch(onError);
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, RETENTION_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
