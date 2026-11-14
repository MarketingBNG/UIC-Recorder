export type Role = "ADMIN" | "MANAGER" | "AGENT";
export type Direction = "INCOMING" | "OUTGOING" | "MISSED" | "UNKNOWN";
export type CallStatus = "PENDING_UPLOAD" | "UPLOADED" | "TRANSCRIBING" | "TRANSCRIBED" | "FAILED";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  team: string | null;
  pictureUrl: string | null;
}
export interface UserRef {
  id: string;
  name: string | null;
  email: string;
}
export interface CallItem {
  id: string;
  phoneE164: string | null;
  phoneRaw: string | null;
  contactName: string | null;
  direction: Direction;
  startedAt: string;
  durationS: number | null;
  status: CallStatus;
  user: UserRef;
  transcript: { language: string | null } | null;
}
export interface CallPage {
  items: CallItem[];
  nextCursor: string | null;
}
export interface CallDetail extends Omit<CallItem, "transcript"> {
  filePath: string | null;
  /** Set when the retention setting deleted the audio (transcript kept). */
  audioDeletedAt?: string | null;
  crm?: CallCrm;
  mimeType: string | null;
  fileSize: string | null;
  transcript: {
    text: string;
    language: string | null;
    provider: string | null;
    /** Provider segments; after translation each object also carries `en`. */
    segments: unknown;
    textEn?: string | null;
    translationModel?: string | null;
    translationPending?: boolean;
    /** AI summary (Milestone 5); absent on older servers, null until summarized. */
    summary?: string | null;
    actionItems?: string[] | null;
    sentiment?: Sentiment | null;
    tags?: string[] | null;
    speakerRoles?: SpeakerRole[] | null;
    summaryModel?: string | null;
    summaryPending?: boolean;
  } | null;
}
export type Sentiment = "positive" | "neutral" | "negative" | "mixed";
export interface SpeakerRole {
  speaker: string;
  role: "Agent" | "Customer" | "Unknown";
}
export interface CompressionStats {
  compressedCalls: number;
  bytesSaved: number;
  /** Transcribed recordings above 40 kbps not compressed or queued yet. */
  eligibleCalls: number;
  queuedJobs: number;
}
export interface TranslateBackfillResult {
  queued: number;
}
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  team: string | null;
  active: boolean;
  excludedNumbers: string[];
  lastLoginAt: string | null;
  createdAt: string;
  _count?: { calls: number };
}
export interface Device {
  id: string;
  userId: string;
  installId: string;
  model: string | null;
  androidVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  pendingCount: number;
  permissionsOk: boolean;
  freeBytes: string | null;
  revokedAt: string | null;
  createdAt: string;
  user: UserRef;
  /** M4 heartbeat fields; absent/null on older servers or apps. */
  standbyBucket?: number | null;
  standbyBucketName?: string | null;
  lastStopReason?: number | null;
  calls7d?: number | null;
  recordings7d?: number | null;
  autostartIntent?: string | null;
  defaultDialer?: string | null;
  throttled?: boolean;
  callsWithoutRecordings?: boolean;
}
export interface Stats {
  calls: Partial<Record<CallStatus, number>>;
  jobs: Record<string, number>;
  disk: { freeBytes: number; totalBytes: number; usedPct: number };
  staleDevices: number;
  fireflies?: FirefliesAlert;
  /** Absent on servers before alerting (M1). */
  throughput?: Throughput;
  alertsEnabled?: boolean;
  /** Absent on servers before cost tracking (M2). */
  translation?: TranslationAlert;
  /** Absent on servers before recording compression (M2b). */
  compression?: CompressionStats;
}
export interface TranslationAlert {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  pct: number;
  capped: boolean;
}
export interface TranslationUsage extends TranslationAlert {
  translatedThisMonth: number;
  /** AI summaries this month (same Claude cap); absent on older servers. */
  summarizedThisMonth?: number;
  avgCostUsd: number | null;
  queuedJobs: number;
  sarvamOverflow: boolean;
}
export interface CostSettingsPatch {
  translateBudgetUsd?: number;
  sarvamOverflow?: boolean;
}
export interface Throughput {
  jobsPerHour: number;
  doneLastHour: number;
  failureRatePct: number;
  failureRatePctLastHour: number;
  avgJobSeconds: number | null;
  backlogCalls: number;
  backlogMinutes: number;
  backlogEtaMonths: number | null;
  backlogEtaHours: number | null;
}
export interface FirefliesAlert {
  month: string;
  pct: number;
  thresholds: number[];
  blocked: boolean;
  lastError: string | null;
  backlogGateReached: boolean;
  waitingBudgetJobs: number;
}
export interface FirefliesUsage {
  month: string;
  enabled: boolean;
  budgetMinutes: number;
  liveReservePct: number;
  usedMinutes: number;
  reservedMinutes: number;
  pct: number;
  thresholds: number[];
  approvedBacklogCount: number;
  backlogSent: number;
  deleteAfterFetch: boolean;
  blocked: boolean;
  blockedUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  waitingBudgetJobs: number;
}
export interface FirefliesSettingsPatch {
  enabled?: boolean;
  budgetMinutes?: number;
  liveReservePct?: number;
  approvedBacklogCount?: number;
  deleteAfterFetch?: boolean;
  clearBlock?: boolean;
}
export interface DeviceConfig {
  recorderFolders: string[];
  liveNetwork: "any" | "wifi";
  backlogEnabled: boolean;
  backlogCutoffDays: number;
  maxParallelUploads: number;
  compressAudio: boolean;
  businessOnly: boolean;
}
/** Admin privacy settings: retentionMonths null = keep audio forever (default). */
export interface PrivacySettings {
  retentionMonths: number | null;
  maskPii: boolean;
}
export interface ClientNumber {
  id: string;
  raw: string;
  label: string | null;
  createdAt: string;
}
export interface ClientImportResult {
  added: number;
  updated: number;
  rejected: number;
  rejectedSample: string[];
}
export type AuditAction =
  | "PLAY"
  | "DOWNLOAD"
  | "SEARCH"
  | "DELETE"
  | "USER_CHANGE"
  | "DEVICE_REVOKE"
  | "SETTINGS_CHANGE"
  | "CLIENT_LIST_CHANGE"
  | "RETENTION_DELETE"
  | "EXPORT"
  | "CRM_SYNC";
/** Zoho CRM sync state of one call (absent on older servers). */
export interface CallCrm {
  enabled: boolean;
  status: "SYNCED" | "NO_MATCH" | "ERROR" | null;
  module: string | null;
  recordId: string | null;
  recordUrl: string | null;
  syncedAt: string | null;
  error: string | null;
  attempts: number;
}
export interface CrmStats {
  enabled: boolean;
  synced: number;
  noMatch: number;
  errors: number;
  queued: number;
  lastError: string | null;
  /** Whole sync paused by an auth / Zoho outage error (retries with backoff). */
  failing?: boolean;
  globalError?: string | null;
}
export interface AuditEntry {
  id: string;
  action: AuditAction | string;
  callId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: string;
  user: UserRef | null;
}
export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}
export interface Settings {
  deviceConfig: DeviceConfig;
  latestApp: { versionCode: number; versionName: string; sha256: string; fileName: string } | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Called on any 401 so the app drops back to the sign-in page. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

/**
 * Same-origin fetch: the browser sends the session cookie and, for non-GET requests,
 * the Origin header the server's CSRF check expects. Content-Type is set only with a
 * body, because Fastify rejects an empty JSON body.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Builds a query string, dropping empty values (the server rejects e.g. "direction="). */
export function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const isManager = (r?: Role) => r === "ADMIN" || r === "MANAGER";

// Activity tracker (dialer plan): contacts are keyed by phone number and owned by the
// rep who first logged an activity for them.
export type ContactStatus = "NEW" | "INTERESTED" | "CALL_BACK" | "NOT_INTERESTED" | "NO_ANSWER";
export type ActivityType = "CALL" | "WHATSAPP" | "NOTE";
export type CallOutcome = "INTERESTED" | "CALL_BACK" | "NOT_INTERESTED" | "NO_ANSWER";
export interface Contact {
  id: string;
  phoneE164: string;
  name: string | null;
  company: string | null;
  status: ContactStatus;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  owner: UserRef | null;
}
export interface ContactListItem extends Contact {
  activityCount: number;
}
export interface ContactPage {
  items: ContactListItem[];
  nextCursor: string | null;
}
export interface Activity {
  id: string;
  clientId: string;
  type: ActivityType;
  outcome: CallOutcome | null;
  note: string | null;
  followUpAt: string | null;
  durationS: number | null;
  occurredAt: string;
  callId: string | null;
}
export type TimelineItem =
  | (Activity & {
      kind: "activity";
      user: UserRef;
      call?: { id: string; status: CallStatus; summary: string | null; hasAudio: boolean } | null;
    })
  | {
      kind: "call";
      id: string;
      direction: Direction;
      startedAt: string;
      durationS: number | null;
      status: CallStatus;
      user: UserRef;
      hasAudio: boolean;
      summary: string | null;
    };
export interface ContactDetail {
  contact: Contact;
  timeline: TimelineItem[];
}
export interface ContactPatch {
  name?: string | null;
  company?: string | null;
  status?: ContactStatus;
  nextFollowUpAt?: string | null;
  ownerId?: string;
}
export interface RepStats {
  user: UserRef;
  callsMade: number;
  answered: number;
  talkTimeS: number;
  whatsapp: number;
  followUpsDueToday: number;
  overdue: number;
}
