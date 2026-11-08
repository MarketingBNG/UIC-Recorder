/** CSV export of the call list (GET /api/calls/export). */

/** Hard cap per export; narrow the filters (dates, person) for more. */
export const EXPORT_MAX_ROWS = 10_000;

export const EXPORT_COLUMNS = [
  "call_id",
  "started_at",
  "direction",
  "number",
  "contact",
  "person",
  "duration_s",
  "status",
  "language",
  "sentiment",
  "tags",
  "summary",
  "action_items",
  "transcript_en",
  "transcript",
] as const;

export interface ExportRow {
  id: string;
  startedAt: Date;
  direction: string;
  phoneE164: string | null;
  phoneRaw: string | null;
  contactName: string | null;
  durationS: number | null;
  status: string;
  user: { name: string | null; email: string };
  transcript: {
    language: string | null;
    text: string;
    textEn: string | null;
    summary: string | null;
    actionItems: unknown;
    sentiment: string | null;
    tags: unknown;
  } | null;
}

/**
 * One CSV cell. Quotes when needed, and neutralises text a spreadsheet would run as a formula
 * (cells starting with = + - @, tab or CR get a leading apostrophe).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("; ") : "");

export function callsCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    const t = r.transcript;
    const cells = [
      r.id,
      r.startedAt.toISOString(),
      r.direction,
      r.phoneE164 ?? r.phoneRaw,
      r.contactName,
      r.user.name ?? r.user.email,
      r.durationS,
      r.status,
      t?.language,
      t?.sentiment,
      list(t?.tags),
      t?.summary,
      list(t?.actionItems),
      t?.textEn,
      t?.text,
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  // BOM so Excel opens UTF-8 (Hindi / Urdu text) correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}
