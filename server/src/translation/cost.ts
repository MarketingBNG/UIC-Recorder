import { z } from "zod";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { monthKey, nextMonthStart } from "../fireflies/budget.js";
import { DEFAULT_DEVICE_CONFIG } from "../settings.js";

type Tx = Db | Prisma.TransactionClient;

/** Claude list prices, USD per million tokens (input, output). Message Batches are half price. */
export const CLAUDE_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
/** Unknown models are charged at the most expensive known rate, so the cap errs on the safe side. */
const FALLBACK_PRICE = { input: 4, output: 20 };
export const BATCH_DISCOUNT = 0.5;

export function claudeCostUsd(model: string, inputTokens: number, outputTokens: number, batch: boolean): number {
  const p = CLAUDE_PRICES[model] ?? FALLBACK_PRICE;
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1e6;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

/** Admin-editable cost settings, stored in settings.costs (JSON). */
export const CostSettings = z.object({
  // Monthly Claude translation cap; translate jobs wait (stay QUEUED) once month-to-date spend reaches it.
  translateBudgetUsd: z.number().min(0).max(1_000_000),
  // Let a TRANSCRIBE_PROVIDER=sarvam worker take backlog jobs parked by the Fireflies monthly budget.
  sarvamOverflow: z.boolean(),
});
export type CostSettings = z.infer<typeof CostSettings>;

export const DEFAULT_COST_SETTINGS: CostSettings = { translateBudgetUsd: 500, sarvamOverflow: false };

export async function getCostSettings(db: Tx): Promise<CostSettings> {
  const row = await db.setting.findUnique({ where: { id: 1 }, select: { costs: true } });
  const parsed = CostSettings.partial().safeParse(row?.costs ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    ...DEFAULT_COST_SETTINGS,
    ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined)),
  };
}

export async function saveCostSettings(db: Tx, costs: CostSettings): Promise<void> {
  await db.setting.upsert({
    where: { id: 1 },
    create: { id: 1, deviceConfig: DEFAULT_DEVICE_CONFIG, costs },
    update: { costs },
  });
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Claude spend recorded this (UTC) month, in USD. */
export async function monthSpendUsd(db: Tx, now = new Date()): Promise<number> {
  const r = await db.job.aggregate({
    _sum: { costUsd: true },
    where: { costAt: { gte: monthStart(now), lt: nextMonthStart(now) } },
  });
  return r._sum.costUsd ?? 0;
}

/** True when translate jobs should not be handed out (month-to-date spend reached the cap). */
export async function translateCapped(db: Tx, now = new Date()): Promise<boolean> {
  const [s, spent] = await Promise.all([getCostSettings(db), monthSpendUsd(db, now)]);
  return spent >= s.translateBudgetUsd;
}

/**
 * Dashboard / app card. The cap is soft: spend is recorded when a job finishes, so jobs already handed out
 * (every worker's running batch and live calls, possibly several batches at once) can push spend past it.
 */
export async function translationUsage(db: Db, now = new Date()) {
  const [s, spent, queued, monthJobs] = await Promise.all([
    getCostSettings(db),
    monthSpendUsd(db, now),
    db.job.count({ where: { kind: "translate", status: "QUEUED" } }),
    db.job.count({ where: { costAt: { gte: monthStart(now), lt: nextMonthStart(now) } } }),
  ]);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const pct = s.translateBudgetUsd > 0 ? Math.round((spent / s.translateBudgetUsd) * 1000) / 10 : 100;
  return {
    month: monthKey(now),
    spentUsd: round2(spent),
    budgetUsd: s.translateBudgetUsd,
    pct,
    capped: spent >= s.translateBudgetUsd,
    translatedThisMonth: monthJobs,
    avgCostUsd: monthJobs > 0 ? Math.round((spent / monthJobs) * 10000) / 10000 : null,
    queuedJobs: queued,
    sarvamOverflow: s.sarvamOverflow,
  };
}
