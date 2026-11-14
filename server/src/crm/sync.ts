/**
 * Zoho CRM sync: every transcribed call becomes a Call activity (+ a transcript Note) on the
 * matching Contact or Lead. Idempotent: crm_call_id / crm_note_id are updated, never duplicated.
 * See docs/zoho-crm-setup.md.
 */
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { numberKey } from "../privacy/clientNumbers.js";
import { type AlertSender, resolveAlert, sendAlert } from "../alerts/cliq.js";
import { Prisma } from "../generated/prisma/client.js";
import { type ZohoClient, ZohoError, type ZohoModule, type ZohoRecord, isGlobalError } from "./zoho.js";

const MIN = 60_000;
export const CRM_TICK_MS = MIN;
/** Calls whose transcript changed this recently are picked up automatically; older ones need a backfill. */
export const CRM_RECENT_MS = 48 * 60 * MIN;
/** With summaries on, wait this long after the transcript for the summary before syncing without it. */
export const CRM_SUMMARY_WAIT_MS = 30 * MIN;
export const CRM_MAX_ATTEMPTS = 8;
export const CRM_BATCH = 20;
export const CRM_BACKFILL_DAYS = 30;
/** How long a claimed call stays locked to this server (a crashed server frees it after this). */
export const CRM_LEASE_MS = 10 * MIN;
/** Whole-loop backoff after an auth / outage failure: 5, 10, 20, 40, 60 min. */
export const CRM_GLOBAL_BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * MIN);
export const CRM_ALERT_KEY = "zoho-crm-sync";
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


/** Thrown out of a tick when Zoho is unusable for every call (auth, scopes, outage). */
export class CrmGlobalError extends Error {}

export class CrmSync {
  private users: { at: number; byEmail: Map<string, string> } | undefined;
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

  /** SQL condition for "ready to sync" (see docs/zoho-crm-setup.md "When calls sync"). */
  private readySql(now: Date): Prisma.Sql {
    const recent = new Date(now.getTime() - CRM_RECENT_MS);
    const summaryCutoff = new Date(now.getTime() - CRM_SUMMARY_WAIT_MS);
    return Prisma.sql`
      c."status" = 'TRANSCRIBED'
      AND c."crm_attempts" < ${CRM_MAX_ATTEMPTS}
      AND (c."crm_next_attempt_at" IS NULL OR c."crm_next_attempt_at" <= ${now})
      AND (c."crm_locked_until" IS NULL OR c."crm_locked_until" <= ${now})
      AND NOT EXISTS (
        SELECT 1 FROM "jobs" j WHERE j."call_id" = c."id"
          AND j."kind" IN ('transcribe', 'translate', 'summarize')
          AND j."status" IN ('QUEUED', 'RUNNING', 'WAITING_BUDGET'))
      AND (${!this.o.summarizeEnabled} OR t."summary" IS NOT NULL OR t."updated_at" <= ${summaryCutoff} OR c."crm_queued_at" IS NOT NULL)
      AND (
        c."crm_queued_at" IS NOT NULL
        OR (c."crm_status" IS NULL AND t."updated_at" >= ${recent})
        OR c."crm_status" = 'ERROR'
        OR (c."crm_status" = 'SYNCED' AND t."updated_at" > c."crm_synced_at"))`;
  }

  /** Calls ready to sync (read only; the loop uses claim()). */
  async candidates(limit = CRM_BATCH): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT c."id" FROM "calls" c JOIN "transcripts" t ON t."call_id" = c."id"
      WHERE ${this.readySql(this.now())}
      ORDER BY c."started_at" ASC LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /**
   * Atomically leases up to `limit` ready calls to this server. FOR UPDATE SKIP LOCKED plus the lease column mean a
   * second container (rolling deploy) gets different calls, or none, never the same one.
   */
  async claim(limit = CRM_BATCH): Promise<string[]> {
    const now = this.now();
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "calls" SET "crm_locked_until" = ${new Date(now.getTime() + CRM_LEASE_MS)}
      WHERE "id" IN (
        SELECT c."id" FROM "calls" c JOIN "transcripts" t ON t."call_id" = c."id"
        WHERE ${this.readySql(now)}
        ORDER BY c."started_at" ASC LIMIT ${limit}
        FOR UPDATE OF c SKIP LOCKED)
      RETURNING "id"`;
    return rows.map((r) => r.id);
  }

  /** Leases one call regardless of readiness (admin resync). False if another sync holds it. */
  private async claimOne(callId: string): Promise<boolean> {
    const now = this.now();
    const n = await this.db.$executeRaw`
      UPDATE "calls" SET "crm_locked_until" = ${new Date(now.getTime() + CRM_LEASE_MS)}
      WHERE "id" = ${callId}::uuid AND ("crm_locked_until" IS NULL OR "crm_locked_until" <= ${now})`;
    return n === 1;
  }

  private async release(ids: string[]) {
    if (ids.length) await this.db.call.updateMany({ where: { id: { in: ids } }, data: { crmLockedUntil: null } });
  }

  /**
   * Syncs one call this server has claimed. Per-call errors are stored on the call with backoff.
   * Global errors (auth, outage) leave the call untouched and are rethrown as CrmGlobalError.
   */
  private async syncClaimed(callId: string): Promise<CrmStatus | "SKIPPED"> {
    try {
      return await this.syncInner(callId);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (isGlobalError(err)) throw new CrmGlobalError(msg);
      const call = await this.db.call.findUnique({ where: { id: callId }, select: { crmAttempts: true } });
      const attempts = (call?.crmAttempts ?? 0) + 1;
      const delay = Math.min(2 ** attempts * MIN, 6 * 60 * MIN);
      await this.db.call.update({
        where: { id: callId },
        data: {
          crmStatus: "ERROR",
          crmSyncError: msg,
          crmAttempts: attempts,
          crmNextAttemptAt: new Date(this.now().getTime() + delay),
          // Out of tries: no longer "queued"; an admin resync starts again.
          ...(attempts >= CRM_MAX_ATTEMPTS ? { crmQueuedAt: null } : {}),
        },
      });
      return "ERROR";
    } finally {
      await this.release([callId]);
    }
  }

  /** Syncs one call now (admin resync, tests). A global error comes back as ERROR with its message; the call is untouched. */
  async syncCall(callId: string): Promise<{ status: CrmStatus | "BUSY" | "SKIPPED"; error?: string }> {
    if (!(await this.claimOne(callId))) return { status: "BUSY" };
    try {
      return { status: await this.syncClaimed(callId) };
    } catch (err) {
      if (err instanceof CrmGlobalError) return { status: "ERROR", error: err.message };
      throw err;
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
        // Saved before anything else can fail, so a retry reuses this Lead instead of creating another.
        await this.db.call.update({ where: { id: call.id }, data: { crmRecordModule: module, crmRecordId: id } });
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
      // The UIC call link also identifies the Call by hand (see the crash-window note below).
      Description: [t?.summary, `Recording and transcript: ${link}`].filter(Boolean).join("\n\n"),
      ...(owner ? { Owner: { id: owner } } : {}),
      ...(module === "Contacts" ? { Who_Id: { id: record.id } } : { What_Id: { id: record.id }, $se_module: module }),
    };
    if (!missed && call.direction !== "INCOMING") callRecord["Outbound_Call_Status"] = "Completed";

    // Crash window: if the server dies after Zoho creates the Call but before crm_call_id is saved below, the
    // retry creates a second Call. Accepted (rare; both carry the same UIC link in Description) rather than
    // searching Zoho before every create.
    const crmCallId = await this.upsert("Calls", call.crmCallId, callRecord);
    // Saved straight away so a failing note never causes a second Call record.
    await this.db.call.update({ where: { id: call.id }, data: { crmCallId, crmRecordModule: module, crmRecordId: record.id } });

    let crmNoteId = call.crmNoteId;
    if (t) {
      const date = call.startedAt.toISOString().slice(0, 10);
      const note = { Note_Title: `Call transcript – ${date}`, Note_Content: noteContent(t, link) };
      crmNoteId = await this.upsert("Notes", crmNoteId, { ...note, Parent_Id: { module: { api_name: module }, id: record.id } });
    }
    await this.db.call.update({ where: { id: call.id }, data: { ...done, crmStatus: "SYNCED", crmNoteId } });
    return "SYNCED";
  }

  /** Updates an existing record; creates a new one only when Zoho says the old one no longer exists. */
  private async upsert(module: string, id: string | null, data: Record<string, unknown>): Promise<string> {
    if (id) {
      try {
        // Only Note_Title / Note_Content can change on a note.
        const { Parent_Id: _p, ...rest } = data;
        return await this.client.update(module, id, rest);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    return this.client.create(module, data);
  }

  /** One loop pass: claims a batch and syncs it. Throws CrmGlobalError (remaining claims released) on auth / outage. */
  async tick(): Promise<number> {
    const ids = await this.claim();
    for (let i = 0; i < ids.length; i++) {
      try {
        await this.syncClaimed(ids[i]!);
      } catch (err) {
        await this.release(ids.slice(i + 1));
        throw err;
      }
    }
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
  async resync(callId: string) {
    await this.db.call.update({ where: { id: callId }, data: { crmQueuedAt: this.now(), crmAttempts: 0, crmNextAttemptAt: null } });
    return this.syncCall(callId);
  }
}

/** Zoho's "this record id doesn't exist" answers: HTTP 404, or INVALID_DATA on the id field. */
export function isNotFound(err: unknown): boolean {
  return err instanceof ZohoError && (err.status === 404 || (err.code === "INVALID_DATA" && err.details?.["api_name"] === "id"));
}

/** Loop-wide health, shown on the dashboard. */
export interface CrmLoopHealth {
  failingSince: Date | null;
  lastError: string | null;
  nextRunAt: Date | null;
}

export async function crmStats(db: Db, enabled: boolean, health?: CrmLoopHealth) {
  const [groups, queued, lastError] = await Promise.all([
    db.call.groupBy({ by: ["crmStatus"], _count: true, where: { crmStatus: { not: null } } }),
    // Rows out of attempts won't run again, so they don't count as queued.
    db.call.count({ where: { crmQueuedAt: { not: null }, crmAttempts: { lt: CRM_MAX_ATTEMPTS } } }),
    db.call.findFirst({ where: { crmStatus: "ERROR" }, orderBy: { updatedAt: "desc" }, select: { crmSyncError: true } }),
  ]);
  const n = (s: CrmStatus) => groups.find((g) => g.crmStatus === s)?._count ?? 0;
  return {
    enabled,
    synced: n("SYNCED"),
    noMatch: n("NO_MATCH"),
    errors: n("ERROR"),
    queued,
    lastError: lastError?.crmSyncError ?? null,
    // Whole sync paused by an auth / outage error (additive).
    failing: !!health?.failingSince,
    globalError: health?.lastError ?? null,
  };
}

export interface CrmLoopOptions {
  db: Db;
  onError: (err: unknown) => void;
  /** Zoho Cliq sender; when set, a global failure raises one deduped alert and success resolves it. */
  alert?: AlertSender | undefined;
  now?: () => Date;
}

/**
 * Drives CrmSync.tick() with a whole-loop backoff after global failures (5 to 60 min).
 * Per-call attempts are not used up while Zoho itself is unusable.
 */
export class CrmLoop {
  readonly health: CrmLoopHealth = { failingSince: null, lastError: null, nextRunAt: null };
  private failures = 0;
  private readonly now: () => Date;

  constructor(
    private readonly sync: CrmSync,
    private readonly o: CrmLoopOptions,
  ) {
    this.now = o.now ?? (() => new Date());
  }

  /** One scheduled run; skipped while backing off. Returns calls processed, or null when skipped / failed. */
  async runOnce(): Promise<number | null> {
    const now = this.now();
    if (this.health.nextRunAt && this.health.nextRunAt > now) return null;
    try {
      const n = await this.sync.tick();
      this.failures = 0;
      this.health.nextRunAt = null;
      if (this.health.failingSince) {
        this.health.failingSince = null;
        this.health.lastError = null;
        if (this.o.alert) await resolveAlert(this.o.db, this.o.alert, CRM_ALERT_KEY, "Zoho CRM sync is working again.", now);
      }
      return n;
    } catch (err) {
      if (!(err instanceof CrmGlobalError)) {
        this.o.onError(err);
        return null;
      }
      const wait = CRM_GLOBAL_BACKOFF_MS[Math.min(this.failures, CRM_GLOBAL_BACKOFF_MS.length - 1)]!;
      this.failures++;
      this.health.failingSince ??= now;
      this.health.lastError = err.message;
      this.health.nextRunAt = new Date(now.getTime() + wait);
      this.o.onError(err);
      if (this.o.alert) {
        const text = `Zoho CRM sync failing: ${err.message}. Next try in ${wait / MIN} min.`;
        await sendAlert(this.o.db, this.o.alert, CRM_ALERT_KEY, text, now).catch((e: unknown) => this.o.onError(e));
      }
      return null;
    }
  }
}

/** Starts the 1-minute CRM loop (main.ts only). stop() stops scheduling and resolves when a running pass ends. */
export function startCrmLoop(loop: CrmLoop): { stop: () => Promise<void> } {
  let current: Promise<unknown> = Promise.resolve();
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    current = loop.runOnce().finally(() => {
      running = false;
    });
  };
  const timer = setInterval(tick, CRM_TICK_MS);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current.catch(() => {});
    },
  };
}

export function crmFromConfig(db: Db, config: Config, client: ZohoClient) {
  return new CrmSync(db, client, {
    publicUrl: config.PUBLIC_URL,
    summarizeEnabled: config.SUMMARIZE_ENABLED,
    createUnknownLeads: config.ZOHO_CREATE_UNKNOWN_LEADS,
  });
}
