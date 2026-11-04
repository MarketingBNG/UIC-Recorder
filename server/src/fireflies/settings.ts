import { z } from "zod";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { DEFAULT_DEVICE_CONFIG } from "../settings.js";

type Tx = Db | Prisma.TransactionClient;

/** Admin-editable Fireflies settings, stored in settings.fireflies (JSON). */
export const FirefliesConfig = z.object({
  enabled: z.boolean(),
  // Monthly upload minutes we allow ourselves (Fireflies counts API uploads).
  budgetMinutes: z.number().int().min(0).max(1_000_000),
  // % of the budget only live calls may use.
  liveReservePct: z.number().min(0).max(100),
  // Backlog/import calls that may be sent in total; admins raise it batch by batch.
  approvedBacklogCount: z.number().int().min(0).max(10_000_000),
  deleteAfterFetch: z.boolean(),
});
export type FirefliesConfig = z.infer<typeof FirefliesConfig>;

export const DEFAULT_FIREFLIES_CONFIG: FirefliesConfig = {
  enabled: true,
  budgetMinutes: 16200,
  liveReservePct: 10,
  approvedBacklogCount: 20,
  deleteAfterFetch: true,
};

/** Hard stop after a Fireflies quota / plan / payment error. */
const BlockState = z.object({
  blockedUntil: z.iso.datetime().nullable().default(null),
  lastError: z.string().nullable().default(null),
  lastErrorAt: z.iso.datetime().nullable().default(null),
});

const Stored = FirefliesConfig.partial().extend(BlockState.shape);
export type FirefliesState = FirefliesConfig & z.infer<typeof BlockState>;

export async function getFirefliesState(db: Tx): Promise<FirefliesState> {
  const row = await db.setting.findUnique({ where: { id: 1 }, select: { fireflies: true } });
  const parsed = Stored.safeParse(row?.fireflies ?? {});
  const stored = parsed.success ? parsed.data : Stored.parse({});
  const merged = { ...DEFAULT_FIREFLIES_CONFIG, ...stripUndefined(stored) };
  return merged as FirefliesState;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function saveFirefliesState(db: Tx, state: FirefliesState): Promise<void> {
  const fireflies = state as object;
  await db.setting.upsert({
    where: { id: 1 },
    // deviceConfig is required; the device-config defaults apply until an admin saves one.
    create: { id: 1, deviceConfig: DEFAULT_DEVICE_CONFIG, fireflies },
    update: { fireflies },
  });
}

/** True while a hard stop is active (it ends at the month rollover or when an admin clears it). */
export function isBlocked(s: FirefliesState, now = new Date()): boolean {
  return !!s.blockedUntil && new Date(s.blockedUntil) > now;
}
