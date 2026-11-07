import { z } from "zod";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { DEFAULT_DEVICE_CONFIG } from "../settings.js";

type Tx = Db | Prisma.TransactionClient;

/** Admin-editable privacy settings, stored in settings.privacy (JSON). */
export const PrivacySettings = z.object({
  // Delete audio files of calls older than this many months (transcripts are kept). null = keep forever.
  retentionMonths: z.number().int().min(1).max(240).nullable(),
  // Worker masks Aadhaar and card numbers in new transcripts before they are stored.
  maskPii: z.boolean(),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

/** Off by default: keep everything forever, store transcripts as transcribed. */
export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = { retentionMonths: null, maskPii: false };

export async function getPrivacySettings(db: Tx): Promise<PrivacySettings> {
  const row = await db.setting.findUnique({ where: { id: 1 }, select: { privacy: true } });
  const parsed = PrivacySettings.partial().safeParse(row?.privacy ?? {});
  const stored = parsed.success ? parsed.data : {};
  return {
    ...DEFAULT_PRIVACY_SETTINGS,
    ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined)),
  };
}

export async function savePrivacySettings(db: Tx, privacy: PrivacySettings): Promise<void> {
  await db.setting.upsert({
    where: { id: 1 },
    create: { id: 1, deviceConfig: DEFAULT_DEVICE_CONFIG, privacy },
    update: { privacy },
  });
}
