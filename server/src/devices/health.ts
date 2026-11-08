/** Phone health flags derived from heartbeat fields (shared by /api/devices and the alert loop). */

/** UsageStatsManager.STANDBY_BUCKET_RARE / _RESTRICTED: Android runs our jobs rarely or almost never. */
export const BUCKET_RARE = 30;
export const BUCKET_RESTRICTED = 45;
/** "Calls but no recordings": more than this many 30 s+ calls in 7 days with zero recordings found. */
export const CALLS_NO_REC_MIN = 5;

export function bucketName(bucket: number | null | undefined): string | null {
  if (bucket == null) return null;
  if (bucket <= 5) return "ACTIVE";
  if (bucket <= 10) return "WORKING_SET";
  if (bucket <= 20) return "FREQUENT";
  if (bucket <= 30) return "RARE";
  if (bucket <= 45) return "RESTRICTED";
  return "NEVER";
}

export interface HealthFields {
  standbyBucket: number | null;
  calls7d: number | null;
  recordings7d: number | null;
}

/** RARE or worse: background uploads may be delayed by hours or days. */
export const isThrottled = (d: HealthFields) => d.standbyBucket != null && d.standbyBucket >= BUCKET_RARE;

/** The dialer is probably not recording (auto-record off, or a dialer whose files we can't read). */
export const callsWithoutRecordings = (d: HealthFields) =>
  d.calls7d != null && d.calls7d > CALLS_NO_REC_MIN && d.recordings7d === 0;
