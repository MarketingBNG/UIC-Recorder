import { createHash } from "node:crypto";
import type { Db } from "../db.js";

/**
 * Same rule as the app's PrivacyFilter.key(): digits only; 10+ digits compare on their last 10,
 * so "+91 98765 43210" == "098765-43210". Keep the two in sync (shared test vector in both test suites).
 */
export function numberKey(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

/** What phones download instead of the clear numbers: lowercase sha256 hex of the key. */
export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

/** Shortest number accepted on the client list (shorter keys would match too much). */
export const MIN_KEY_DIGITS = 6;
export const MAX_CLIENT_NUMBERS = 200_000;

export interface ParsedRow {
  raw: string;
  key: string;
  label: string | null;
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").trim();

/**
 * Parses CSV or plain text: one number per line, optional label after the first comma, semicolon or tab.
 * Header rows and lines without enough digits come back in `rejected`.
 */
export function parseClientCsv(text: string): { rows: ParsedRow[]; rejected: string[] } {
  const rows = new Map<string, ParsedRow>();
  const rejected: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [first = "", ...rest] = trimmed.split(/[,;\t]/);
    const raw = unquote(first);
    const key = numberKey(raw);
    if (key.length < MIN_KEY_DIGITS) {
      rejected.push(trimmed.slice(0, 100));
      continue;
    }
    const label = unquote(rest.join(",")).slice(0, 200) || null;
    const prev = rows.get(key);
    // A repeated number keeps its first spelling; a later label wins over none.
    rows.set(key, { raw: prev?.raw ?? raw.slice(0, 40), key, label: label ?? prev?.label ?? null });
  }
  return { rows: [...rows.values()], rejected };
}

/** Inserts new numbers; an existing number keeps its row and gets the new label when one is given. */
export async function importClientNumbers(db: Db, rows: ParsedRow[]): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const existing = new Set(
      (await db.clientNumber.findMany({ where: { key: { in: chunk.map((r) => r.key) } }, select: { key: true } })).map((r) => r.key),
    );
    const fresh = chunk.filter((r) => !existing.has(r.key));
    if (fresh.length > 0) added += (await db.clientNumber.createMany({ data: fresh, skipDuplicates: true })).count;
    for (const r of chunk.filter((r) => existing.has(r.key) && r.label)) {
      await db.clientNumber.update({ where: { key: r.key }, data: { label: r.label } });
      updated++;
    }
  }
  return { added, updated };
}
