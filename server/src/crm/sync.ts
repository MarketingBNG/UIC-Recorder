/**
 * Zoho CRM sync: every transcribed call becomes a Call activity (+ a transcript Note) on the
 * matching Contact or Lead. Idempotent: crm_call_id / crm_note_id are updated, never duplicated.
 * See docs/zoho-crm-setup.md.
 */
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { numberKey } from "../privacy/clientNumbers.js";
import { type ZohoClient, ZohoError, type ZohoModule, type ZohoRecord } from "./zoho.js";

const MIN = 60_000;
export const CRM_TICK_MS = MIN;
/** Calls whose transcript changed this recently are picked up automatically; older ones need a backfill. */
export const CRM_RECENT_MS = 48 * 60 * MIN;
/** With summaries on, wait this long after the transcript for the summary before syncing without it. */
export const CRM_SUMMARY_WAIT_MS = 30 * MIN;
export const CRM_MAX_ATTEMPTS = 8;
export const CRM_BATCH = 20;
export const CRM_BACKFILL_DAYS = 30;
const USERS_TTL_MS = 60 * MIN;
/** Zoho does not publish a Note_Content limit; stay well under the 32k long-text size. */
export const NOTE_MAX_CHARS = 30_000;
export const LEAD_SOURCE = "UIC Dialer";

export type CrmStatus = "SYNCED" | "NO_MATCH" | "ERROR";

export interface CrmSyncOptions {
  publicUrl: string;
  summarizeEnabled: boolean;
  createUnknownLeads: boolean;
  /** Zoho CRM web UI base, for record links. */
  crmWebUrl?: string;
  now?: () => Date;
}

/** Zoho CRM web URL of a record (the UI redirects to the org's own path). */
export function crmRecordUrl(webUrl: string, module: string, id: string) {
  return `${webUrl.replace(/\/$/, "")}/crm/tab/${module}/${id}`;
}

/** "2026-11-14T10:05:00+05:30": Zoho wants ISO 8601 with an offset; shown in IST. */
export function zohoDateTime(d: Date): string {
  const ist = new Date(d.getTime() + 330 * MIN);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
}

/** mm:ss (minutes may exceed 59). Inbound/outbound calls can't be zero. */
export function zohoDuration(seconds: number | null | undefined, missed: boolean): string {
  const s = Math.max(missed ? 0 : 1, Math.round(seconds ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const CALL_TYPE = { INCOMING: "Inbound", OUTGOING: "Outbound", MISSED: "Missed", UNKNOWN: "Outbound" } as const;

/** Most recently modified first. */
const newest = (rs: ZohoRecord[]) =>
  [...rs].sort((a, b) => Date.parse(b.Modified_Time ?? "") - Date.parse(a.Modified_Time ?? "") || 0)[0];

export async function matchRecord(client: ZohoClient, phone: string): Promise<{ module: ZohoModule; record: ZohoRecord } | null> {
  const key = numberKey(phone);
  if (key.length < 6) return null;
  // Contact wins over Lead (a converted lead is usually the contact now).
  const contacts = await client.searchByPhone("Contacts", key);
  if (contacts.length) return { module: "Contacts", record: newest(contacts)! };
  const leads = await client.searchByPhone("Leads", key);
  if (leads.length) return { module: "Leads", record: newest(leads)! };
  return null;
}

const recordName = (r: ZohoRecord) => (r.Full_Name ?? r.Last_Name ?? "") as string;

/** Text pieces of the transcript note. */
export function noteContent(t: { summary: string | null; actionItems: unknown; text: string; textEn: string | null }, link: string) {
  const parts: string[] = [];
  if (t.summary) parts.push(`Summary:\n${t.summary}`);
  const items = Array.isArray(t.actionItems) ? t.actionItems.filter((x): x is string => typeof x === "string") : [];
  if (items.length) parts.push(`Action items:\n${items.map((i) => `- ${i}`).join("\n")}`);
  parts.push(`Recording: ${link}`);
  const head = parts.join("\n\n");
  const body = `\n\nTranscript (English):\n${t.textEn ?? t.text}`;
  const full = head + body;
  if (full.length <= NOTE_MAX_CHARS) return full;
  const cut = "\n[transcript truncated; full text in UIC Dialer]";
  return full.slice(0, NOTE_MAX_CHARS - cut.length) + cut;
}

export class CrmSync {
  private users: { at: number; byEmail: Map<string, string> } | undefined;
  private readonly inFlight = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly client: ZohoClient,
    private readonly o: CrmSyncOptions,
  ) {
    this.now = o.now ?? (() => new Date());
  }

  /** Zoho user id for a rep's email; undefined = let Zoho use the default owner. Cached for an hour. */
  async ownerId(email: string): Promise<string | undefined> {
    const now = this.now().getTime();
    if (!this.users || now - this.users.at > USERS_TTL_MS) {
      const list = await this.client.activeUsers();
      this.users = { at: now, byEmail: new Map(list.map((u) => [u.email.toLowerCase(), u.id])) };
    }
    return this.users.byEmail.get(email.toLowerCase());
  }

  /** Syncs one call. Returns the resulting status; never throws (errors are stored on the call). */
  async syncCall(callId: string): Promise<CrmStatus | "BUSY" | "SKIPPED"> {
    if (this.inFlight.has(callId)) return "BUSY";
    this.inFlight.add(callId);
    try {
      return await this.syncInner(callId);
    } catch (err) {
      const call = await this.db.call.findUnique({ where: { id: callId }, select: { crmAttempts: true } });
      const attempts = (call?.crmAttempts ?? 0) + 1;
      const delay = Math.min(2 ** attempts * MIN, 6 * 60 * MIN);
      const msg = err instanceof Error ? err.message : String(err);
      await this.db.call.update({
        where: { id: callId },
        data: {
          crmStatus: "ERROR",
          crmSyncError: msg.slice(0, 500),
          crmAttempts: attempts,
          crmNextAttemptAt: new Date(this.now().getTime() + delay),
        },
      });
      return "ERROR";
    } finally {
      this.inFlight.delete(callId);
    }
  }

  private async syncInner(callId: string): Promise<CrmStatus | "SKIPPED"> {
    const call = await this.db.call.findUnique({
      where: { id: callId },
      include: { user: { select: { email: true, name: true } }, transcript: true },
    });
    if (!call) return "SKIPPED";
    const now = this.now();
    const done = { crmSyncError: null, crmAttempts: 0, crmQueuedAt: null, crmNextAttemptAt: null, crmSyncedAt: now };

    // Linked record: keep the one we already used, so re-syncs update the same Call / Note.
    let module = call.crmRecordModule as ZohoModule | null;
    let record: { id: string; name: string } | null = module && call.crmRecordId ? { id: call.crmRecordId, name: "" } : null;
    if (!record) {
      const phone = call.phoneE164 ?? call.phoneRaw;
      const m = phone ? await matchRecord(this.client, phone) : null;
      if (m) {
        module = m.module;
        record = { id: m.record.id, name: recordName(m.record) };
      } else if (phone && this.o.createUnknownLeads) {
        module = "Leads";
        const name = call.contactName?.trim() || phone;
        const id = await this.client.create("Leads", { Last_Name: name, Phone: call.phoneE164 ?? phone, Lead_Source: LEAD_SOURCE });
        record = { id, name };
      } else {
        await this.db.call.update({ where: { id: call.id }, data: { ...done, crmStatus: "NO_MATCH" } });
        return "NO_MATCH";
      }
    }
    if (!module || !record) return "SKIPPED";

    const link = `${this.o.publicUrl.replace(/\/$/, "")}/calls/${call.id}`;
    const owner = await this.ownerId(call.user.email);
    const rep = call.user.name ?? call.user.email;
    const missed = call.direction === "MISSED";
    const t = call.transcript;
    const callRecord: Record<string, unknown> = {
      Subject: `${CALL_TYPE[call.direction]} call by ${rep}`.slice(0, 255),
      Call_Type: CALL_TYPE[call.direction],
      Call_Start_Time: zohoDateTime(call.startedAt),
      Call_Duration: zohoDuration(call.durationS, missed),
      Description: [t?.summary, `Recording and transcript: ${link}`].filter(Boolean).join("\n\n"),
      ...(owner ? { Owner: { id: owner } } : {}),
      ...(module === "Contacts" ? { Who_Id: { id: record.id } } : { What_Id: { id: record.id }, $se_module: module }),
    };
    if (!missed && call.direction !== "INCOMING") callRecord["Outbound_Call_Status"] = "Completed";

    const crmCallId = await this.upsert("Calls", call.crmCallId, callRecord);
    // Saved straight away so a failing note never causes a second Call record.
    await this.db.call.update({ where: { id: call.id }, data: { crmCallId, crmRecordModule: module, crmRecordId: record.id } });

    let crmNoteId = call.crmNoteId;
    if (t) {
      const date = call.startedAt.toISOString().slice(0, 10);
      const note = {
        Note_Title: `Call transcript – ${date}`,
        Note_Content: noteContent(t, link),
      };
      crmNoteId = await this.upsert("Notes", crmNoteId, { ...note, Parent_Id: { module: { api_name: module }, id: record.id } });
    }
    await this.db.call.update({ where: { id: call.id }, data: { ...done, crmStatus: "SYNCED", crmNoteId } });
    return "SYNCED";
  }

  /** Updates an existing record; creates it if there is none or it was deleted in Zoho. */
  private async upsert(module: string, id: string | null, data: Record<string, unknown>): Promise<string> {
    if (id) {
      try {
        // Only Note_Title / Note_Content can change on a note.
        const { Parent_Id: _p, ...rest } = data;
        return await this.client.update(module, id, rest);
      } catch (err) {
        // Deleted in Zoho: make a fresh one (any other error is a real failure).
        if (!(err instanceof ZohoError && (err.code === "INVALID_DATA" || err.status === 404))) throw err;
      }
    }
    return this.client.create(module, data);
  }

  /** Calls ready to sync (see docs/zoho-crm-setup.md "When calls sync"). */
  async candidates(limit = CRM_BATCH): Promise<string[]> {
    const now = this.now();
    const recent = new Date(now.getTime() - CRM_RECENT_MS);
    const summaryCutoff = new Date(now.getTime() - CRM_SUMMARY_WAIT_MS);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT c."id" FROM "calls" c
      JOIN "transcripts" t ON t."call_id" = c."id"
      WHERE c."status" = 'TRANSCRIBED'
        AND c."crm_attempts" < ${CRM_MAX_ATTEMPTS}
        AND (c."crm_next_attempt_at" IS NULL OR c."crm_next_attempt_at" <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM "jobs" j WHERE j."call_id" = c."id"
            AND j."kind" IN ('transcribe', 'translate', 'summarize')
            AND j."status" IN ('QUEUED', 'RUNNING', 'WAITING_BUDGET'))
        AND (${!this.o.summarizeEnabled} OR t."summary" IS NOT NULL OR t."updated_at" <= ${summaryCutoff} OR c."crm_queued_at" IS NOT NULL)
        AND (
          c."crm_queued_at" IS NOT NULL
          OR (c."crm_status" IS NULL AND t."updated_at" >= ${recent})
          OR c."crm_status" = 'ERROR'
          OR (c."crm_status" = 'SYNCED' AND t."updated_at" > c."crm_synced_at"))
      ORDER BY c."started_at" ASC
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async tick(): Promise<number> {
    const ids = await this.candidates();
    for (const id of ids) await this.syncCall(id);
    return ids.length;
  }

  /** Marks the last N days of transcribed calls (not yet synced) for the loop. */
  async queueBackfill(days = CRM_BACKFILL_DAYS): Promise<number> {
    const since = new Date(this.now().getTime() - days * 24 * 60 * MIN);
    const r = await this.db.call.updateMany({
      where: { status: "TRANSCRIBED", startedAt: { gte: since }, OR: [{ crmStatus: null }, { crmStatus: { not: "SYNCED" } }] },
      data: { crmQueuedAt: this.now(), crmAttempts: 0, crmNextAttemptAt: null },
    });
    return r.count;
  }

  /** Admin resync of one call: clears backoff, syncs now. */
  async resync(callId: string): Promise<CrmStatus | "BUSY" | "SKIPPED"> {
    await this.db.call.update({ where: { id: callId }, data: { crmQueuedAt: this.now(), crmAttempts: 0, crmNextAttemptAt: null } });
    return this.syncCall(callId);
  }
}

export async function crmStats(db: Db, enabled: boolean) {
  const [groups, pending, lastError] = await Promise.all([
    db.call.groupBy({ by: ["crmStatus"], _count: true, where: { crmStatus: { not: null } } }),
    db.call.count({ where: { crmQueuedAt: { not: null } } }),
    db.call.findFirst({ where: { crmStatus: "ERROR" }, orderBy: { updatedAt: "desc" }, select: { crmSyncError: true } }),
  ]);
  const n = (s: CrmStatus) => groups.find((g) => g.crmStatus === s)?._count ?? 0;
  return { enabled, synced: n("SYNCED"), noMatch: n("NO_MATCH"), errors: n("ERROR"), queued: pending, lastError: lastError?.crmSyncError ?? null };
}

export function startCrmLoop(sync: CrmSync, onError: (err: unknown) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sync.tick();
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CRM_TICK_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

export function crmFromConfig(db: Db, config: Config, client: ZohoClient) {
  return new CrmSync(db, client, {
    publicUrl: config.PUBLIC_URL,
    summarizeEnabled: config.SUMMARIZE_ENABLED,
    createUnknownLeads: config.ZOHO_CREATE_UNKNOWN_LEADS,
  });
}
