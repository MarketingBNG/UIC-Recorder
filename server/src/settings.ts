import { z } from "zod";
import type { Db } from "./db.js";

/** Config pushed to every phone; admins change it without shipping a new APK. */
export const DeviceConfig = z.object({
  recorderFolders: z.array(z.string().max(200)).max(50),
  liveNetwork: z.enum(["any", "wifi"]),
  backlogEnabled: z.boolean(),
  backlogCutoffDays: z.number().int().min(0).max(3650),
  maxParallelUploads: z.number().int().min(1).max(4),
  compressAudio: z.boolean(),
  businessOnly: z.boolean(),
});
export type DeviceConfig = z.infer<typeof DeviceConfig>;

export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  recorderFolders: [
    "Recordings/Call",
    "Recordings/Call recordings",
    "Call recordings",
    "Music/Recordings/Call Recordings",
    "MIUI/sound_recorder/call_rec",
    "Sounds/CallRecord",
    "Record/Call",
    "Recorder/call",
    "PhoneRecord",
    "CallRecordings",
  ],
  liveNetwork: "any",
  backlogEnabled: true,
  backlogCutoffDays: 365,
  maxParallelUploads: 2,
  compressAudio: true,
  businessOnly: false,
};

export const LatestApp = z.object({
  versionCode: z.number().int().positive(),
  versionName: z.string().max(40),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().regex(/^[\w.-]+\.apk$/),
});
export type LatestApp = z.infer<typeof LatestApp>;

export async function getSettings(db: Db) {
  const row = await db.setting.findUnique({ where: { id: 1 } });
  const deviceConfig = DeviceConfig.safeParse(row?.deviceConfig);
  const latestApp = LatestApp.safeParse(row?.latestApp);
  return {
    deviceConfig: deviceConfig.success ? deviceConfig.data : DEFAULT_DEVICE_CONFIG,
    latestApp: latestApp.success ? latestApp.data : null,
  };
}
