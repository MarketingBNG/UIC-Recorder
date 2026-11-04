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
  mimeType: string | null;
  fileSize: string | null;
  transcript: { text: string; language: string | null; provider: string | null; segments: unknown } | null;
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
}
export interface Stats {
  calls: Partial<Record<CallStatus, number>>;
  jobs: Record<string, number>;
  disk: { freeBytes: number; totalBytes: number; usedPct: number };
  staleDevices: number;
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
