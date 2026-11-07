import type { Db } from "../db.js";

/** Sends one message to the alert channel; resolves true when the channel accepted it. */
export type AlertSender = (text: string) => Promise<boolean>;

/** An active alert repeats at most this often. */
export const REPEAT_MS = 6 * 3600_000;
const TIMEOUT_MS = 10_000;

/**
 * Zoho Cliq channel incoming webhook (`.../message?zapikey=...`), body `{ text }`.
 * Never throws; failures are reported through `log` without the URL (it holds the key).
 */
export function cliqSender(
  url: string,
  log: (msg: string) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  const host = new URL(url).host;
  return async (text) => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) log(`Cliq webhook (${host}) answered ${res.status}`);
      return res.ok;
    } catch (err) {
      log(`Cliq webhook (${host}) failed: ${(err as Error).message}`);
      return false;
    }
  };
}

/**
 * Raises (or keeps raising) an alert. Sends when it is new, or still active and the last
 * message is older than REPEAT_MS. The claim is a conditional update, so two server
 * instances never both send; a failed send is rolled back and retried on the next run.
 */
export async function sendAlert(
  db: Db,
  send: AlertSender,
  key: string,
  text: string,
  now = new Date(),
  opts: { repeat?: boolean } = {},
): Promise<boolean> {
  await db.alertState.createMany({ data: [{ key }], skipDuplicates: true });
  const before = await db.alertState.findUniqueOrThrow({ where: { key } });
  // repeat: false sends once per activation (e.g. a budget threshold).
  const cutoff = opts.repeat === false ? new Date(0) : new Date(now.getTime() - REPEAT_MS);
  const { count } = await db.alertState.updateMany({
    where: {
      key,
      active: before.active,
      lastSentAt: before.lastSentAt,
      OR: [{ active: false }, { lastSentAt: null }, { lastSentAt: { lt: cutoff } }],
    },
    data: { active: true, message: text, lastSentAt: now, firstAt: before.active ? before.firstAt : now, resolvedAt: null },
  });
  if (count !== 1) return false;
  const repeat = before.active && before.lastSentAt !== null;
  if (await send(repeat ? `${text}\n(still happening)` : text)) return true;
  await db.alertState.update({
    where: { key },
    data: { active: before.active, lastSentAt: before.lastSentAt, firstAt: before.firstAt, message: before.message },
  });
  return false;
}

/** Clears an active alert and posts a single "resolved" message. No-op if it wasn't active. */
export async function resolveAlert(db: Db, send: AlertSender, key: string, text: string, now = new Date()): Promise<boolean> {
  const { count } = await db.alertState.updateMany({ where: { key, active: true }, data: { active: false, resolvedAt: now } });
  if (count !== 1) return false;
  if (await send(`Resolved: ${text}`)) return true;
  await db.alertState.update({ where: { key }, data: { active: true, resolvedAt: null } });
  return false;
}
