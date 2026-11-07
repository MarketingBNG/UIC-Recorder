import type { Db } from "../db.js";
import { firefliesUsage } from "../fireflies/budget.js";
import type { LocalStorage } from "../storage/local.js";
import { type AlertSender, resolveAlert, sendAlert } from "./cliq.js";
import { jobStats } from "./metrics.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CHECK_INTERVAL_MS = 5 * MIN;
export const WORKER_SILENT_MS = 10 * MIN;
export const FAILURE_RATE_PCT = 5;
/** Fewer finished jobs than this in the hour can't trip the failure-rate alert. */
export const FAILURE_MIN_JOBS = 10;
export const QUEUE_STALL_MS = 2 * HOUR;
export const DISK_PCT = 80;
export const PHONE_SILENT_MS = 48 * HOUR;
const FIREFLIES_THRESHOLDS = [80, 100] as const;
const WORKER_SEEN_KEEP_MS = 7 * 24 * HOUR;

export interface CheckResult {
  key: string;
  firing: boolean;
  /** Message while firing; also used (prefixed "Resolved:") when it clears. */
  text: string;
  /** false: send once per activation instead of every 6 h. */
  repeat?: boolean;
}

/** Records that a worker polled or heartbeated. Writes at most every 30 s per worker. */
export async function touchWorker(db: Db, workerId: string, now = new Date()) {
  await db.$executeRaw`
    INSERT INTO "worker_seen" ("worker_id", "last_seen_at") VALUES (${workerId}, ${now})
    ON CONFLICT ("worker_id") DO UPDATE SET "last_seen_at" = excluded."last_seen_at"
    WHERE "worker_seen"."last_seen_at" < ${new Date(now.getTime() - 30_000)}`;
}

async function workerCheck(db: Db, now: Date): Promise<CheckResult> {
  // Worker IDs change on restart, so the newest sighting of any worker counts.
  const newest = await db.workerSeen.findFirst({ orderBy: { lastSeenAt: "desc" } });
  const silent = !!newest && now.getTime() - newest.lastSeenAt.getTime() > WORKER_SILENT_MS;
  const mins = newest ? Math.round((now.getTime() - newest.lastSeenAt.getTime()) / MIN) : 0;
  return {
    key: "worker-down",
    firing: silent,
    text: silent ? `Worker down: no transcription worker has contacted the server for ${mins} min.` : "Worker is polling again.",
  };
}

async function firefliesChecks(db: Db, now: Date): Promise<CheckResult[]> {
  const ff = await firefliesUsage(db, now);
  return [
    {
      key: "fireflies-blocked",
      firing: ff.blocked,
      text: ff.blocked
        ? `Fireflies hard stop until ${ff.blockedUntil}: ${ff.lastError ?? "limit reached"}. Transcription is paused.`
        : "Fireflies hard stop cleared.",
    },
    ...FIREFLIES_THRESHOLDS.map((t) => ({
      key: `fireflies-budget-${t}`,
      firing: ff.pct >= t,
      text: ff.pct >= t
        ? `Fireflies budget ${ff.pct}% used for ${ff.month} (${ff.usedMinutes + ff.reservedMinutes}/${ff.budgetMinutes} min, ${t}% threshold).`
        : `Fireflies budget back under ${t}% (${ff.pct}% for ${ff.month}).`,
      repeat: false,
    })),
  ];
}

async function queueChecks(db: Db, now: Date): Promise<CheckResult[]> {
  const hour = await jobStats(db, HOUR, now);
  const total = hour.done + hour.failed;
  const failing = total >= FAILURE_MIN_JOBS && hour.failureRatePct > FAILURE_RATE_PCT;

  // Stalled: runnable QUEUED jobs (not budget-deferred, not in backoff) have waited 2 h
  // and nothing finished meanwhile.
  const stallCutoff = new Date(now.getTime() - QUEUE_STALL_MS);
  const [oldestRunnable, finishedRecently, runnable] = await Promise.all([
    db.job.findFirst({ where: { status: "QUEUED", runAfter: { lte: stallCutoff } }, select: { id: true } }),
    db.job.count({ where: { status: "DONE", finishedAt: { gt: stallCutoff, lte: now } } }),
    db.job.count({ where: { status: "QUEUED", runAfter: { lte: now } } }),
  ]);
  const stalled = !!oldestRunnable && finishedRecently === 0;
  return [
    {
      key: "job-failure-rate",
      firing: failing,
      text: failing
        ? `Job failures: ${hour.failed} of ${total} transcription jobs failed in the last hour (${hour.failureRatePct}%).`
        : "Transcription failure rate is back to normal.",
    },
    {
      key: "queue-stalled",
      firing: stalled,
      text: stalled
        ? `Queue not moving: ${runnable} jobs are queued and none finished in the last ${QUEUE_STALL_MS / HOUR} h.`
        : "Queue is moving again.",
    },
  ];
}

async function diskCheck(storage: LocalStorage): Promise<CheckResult | null> {
  try {
    const d = await storage.diskUsage();
    const pct = Math.round((1 - d.freeBytes / d.totalBytes) * 100);
    const gb = (d.freeBytes / 1024 ** 3).toFixed(1);
    return {
      key: "disk",
      firing: pct > DISK_PCT,
      text: pct > DISK_PCT ? `Server disk ${pct}% full (${gb} GB free).` : `Server disk back to ${pct}% used.`,
    };
  } catch {
    return null; // probe failed: leave the alert as it was
  }
}

async function phoneCheck(db: Db, now: Date): Promise<CheckResult> {
  const silent = await db.device.findMany({
    where: { revokedAt: null, user: { active: true }, lastSeenAt: { lt: new Date(now.getTime() - PHONE_SILENT_MS) } },
    orderBy: { lastSeenAt: "asc" },
    select: { model: true, user: { select: { name: true, email: true } } },
  });
  const names = silent.slice(0, 10).map((d) => `${d.user.name ?? d.user.email} (${d.model ?? "phone"})`);
  const more = silent.length > names.length ? ` and ${silent.length - names.length} more` : "";
  return {
    key: "phones-silent",
    firing: silent.length > 0,
    text: silent.length > 0
      ? `${silent.length} phone(s) not seen for ${PHONE_SILENT_MS / HOUR} h: ${names.join(", ")}${more}.`
      : "All phones have checked in.",
  };
}

/** Claude spend vs. its monthly cap. Spend isn't tracked until Milestone 2, so this never fires yet. */
async function claudeSpendCheck(): Promise<CheckResult | null> {
  return null;
}

/** Evaluates every check. A check that errors is skipped (its alert state is left alone). */
export async function evaluateChecks(db: Db, storage: LocalStorage, now = new Date()): Promise<CheckResult[]> {
  const parts = await Promise.all([
    workerCheck(db, now).catch(() => null),
    firefliesChecks(db, now).catch(() => []),
    queueChecks(db, now).catch(() => []),
    diskCheck(storage),
    phoneCheck(db, now).catch(() => null),
    claudeSpendCheck(),
  ]);
  return parts.flat().filter((c): c is CheckResult => c !== null);
}

/** One alert pass: raise firing checks, resolve cleared ones. */
export async function runChecks(db: Db, storage: LocalStorage, send: AlertSender, now = new Date()) {
  const results = await evaluateChecks(db, storage, now);
  for (const c of results) {
    if (c.firing) await sendAlert(db, send, c.key, c.text, now, { repeat: c.repeat ?? true });
    else await resolveAlert(db, send, c.key, c.text, now);
  }
  await db.workerSeen.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - WORKER_SEEN_KEEP_MS) } } });
  return results;
}

/** Starts the 5-minute alert loop (main.ts only). Returns a stop function. */
export function startAlertLoop(
  db: Db,
  storage: LocalStorage,
  send: AlertSender,
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runChecks(db, storage, send);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
