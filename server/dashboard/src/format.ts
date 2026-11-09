import type { CallOutcome, CallStatus, ContactStatus, Direction } from "./api";

// Times show in the viewer's own time zone (IST for the India team), like the Android app.
const whenFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const shortFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export const formatWhen = (iso: string | null | undefined) => (iso ? whenFmt.format(new Date(iso)) : "—");
export const formatShortWhen = (iso: string) => {
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? shortFmt.format(d) : whenFmt.format(d);
};

export function formatDuration(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function formatBytes(n: number | string | null | undefined) {
  if (n == null) return "—";
  let v = Number(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const DIRECTION_LABEL: Record<Direction, string> = {
  INCOMING: "Incoming",
  OUTGOING: "Outgoing",
  MISSED: "Missed",
  UNKNOWN: "Unknown",
};
export const STATUS_LABEL: Record<CallStatus, string> = {
  PENDING_UPLOAD: "Waiting for upload",
  UPLOADED: "Uploaded",
  TRANSCRIBING: "Transcribing",
  TRANSCRIBED: "Transcribed",
  FAILED: "Failed",
};

export const JOB_STATUS_LABEL: Record<string, string> = { WAITING_BUDGET: "Waiting for budget" };
export const jobStatusLabel = (k: string) => JOB_STATUS_LABEL[k] ?? k.charAt(0) + k.slice(1).toLowerCase();

export interface Segment {
  startMs: number | null;
  speaker: string | null;
  text: string;
  /** English translation of `text`, when the transcript has been translated. */
  en: string | null;
}

/** Provider-specific segments; same rules as the Android app's parseSegments(). */
export function parseSegments(json: unknown): Segment[] {
  let arr: unknown[] = [];
  if (Array.isArray(json)) arr = json;
  else if (json && typeof json === "object") {
    const s = (json as { segments?: unknown }).segments;
    if (Array.isArray(s)) arr = s;
  }
  const out: Segment[] = [];
  for (const el of arr) {
    if (!el || typeof el !== "object" || Array.isArray(el)) continue;
    const o = el as Record<string, unknown>;
    const num = (k: string) => {
      const v = o[k];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const rawText = o["text"];
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) continue;
    const ms = num("startMs") ?? num("start_ms");
    const sec = num("start") ?? num("from");
    const startMs = ms != null ? Math.trunc(ms) : sec != null ? Math.trunc(sec * 1000) : null;
    const sp = o["speaker"];
    const speaker = typeof sp === "string" ? sp : typeof sp === "number" || typeof sp === "boolean" ? String(sp) : null;
    const rawEn = o["en"];
    const en = typeof rawEn === "string" && rawEn.trim() ? rawEn.trim() : null;
    out.push({ startMs, speaker, text, en });
  }
  return out;
}

export const personName = (u: { name: string | null; email: string }) => u.name || u.email;

export const CONTACT_STATUS_LABEL: Record<ContactStatus, string> = {
  NEW: "New",
  INTERESTED: "Interested",
  CALL_BACK: "Call back",
  NOT_INTERESTED: "Not interested",
  NO_ANSWER: "No answer",
};
export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  INTERESTED: "Interested",
  CALL_BACK: "Call back",
  NOT_INTERESTED: "Not interested",
  NO_ANSWER: "No answer",
};

// Follow-up days are India calendar days (Asia/Kolkata, UTC+5:30, no DST), whatever the viewer's zone.
const IST_OFFSET_MS = 330 * 60_000;
/** yyyy-mm-dd of the IST calendar day containing `t`. */
export const istDay = (t = Date.now()) => new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
/** ISO instant for the start (or end) of an IST yyyy-mm-dd day. */
export function istDayBoundary(day: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const start = Date.parse(`${day}T00:00:00+05:30`);
  if (Number.isNaN(start)) return undefined;
  return new Date(end ? start + 86_400_000 - 1 : start).toISOString();
}
/** True when a follow-up falls before the start of today in IST. */
export const isOverdue = (iso: string | null | undefined, now = Date.now()) =>
  !!iso && new Date(iso).getTime() < Date.parse(`${istDay(now)}T00:00:00+05:30`);

/** Value for <input type="datetime-local"> in the viewer's zone, and back to ISO. */
export function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
