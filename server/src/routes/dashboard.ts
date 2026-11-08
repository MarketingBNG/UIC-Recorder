import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { callScope, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import { Prisma, type AuditAction, type User } from "../generated/prisma/client.js";
import { DeviceConfig, getSettings } from "../settings.js";
import { bucketName, callsWithoutRecordings, isThrottled } from "../devices/health.js";
import { firefliesUsage } from "../fireflies/budget.js";
import { compressionStats, queueCompressionBackfill, queueSummaryBackfill, queueTranslationBackfill } from "../jobs/queue.js";
import { EXPORT_MAX_ROWS, callsCsv } from "../calls/export.js";
import { cliqSender } from "../alerts/cliq.js";
import { throughput } from "../alerts/metrics.js";
import { CostSettings, getCostSettings, saveCostSettings, translationUsage } from "../translation/cost.js";
import { MAX_CLIENT_NUMBERS, MIN_KEY_DIGITS, importClientNumbers, numberKey, parseClientCsv } from "../privacy/clientNumbers.js";
import { PrivacySettings, getPrivacySettings, savePrivacySettings } from "../privacy/settings.js";

const AUDIT_ACTIONS = ["PLAY", "DOWNLOAD", "SEARCH", "DELETE", "USER_CHANGE", "DEVICE_REVOKE", "SETTINGS_CHANGE", "CLIENT_LIST_CHANGE", "RETENTION_DELETE", "EXPORT"] as const;
const AuditQuery = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  userId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const ClientNumberBody = z.object({ number: z.string().trim().min(1).max(40), label: z.string().trim().max(200).optional() });

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  userId: z.uuid().optional(),
  direction: z.enum(["INCOMING", "OUTGOING", "MISSED", "UNKNOWN"]).optional(),
  status: z.enum(["PENDING_UPLOAD", "UPLOADED", "TRANSCRIBING", "TRANSCRIBED", "FAILED"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UserBody = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  name: z.string().max(200).optional(),
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]).default("AGENT"),
  team: z.string().max(100).optional(),
});
const UserPatch = z.object({
  name: z.string().max(200).nullable().optional(),
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]).optional(),
  team: z.string().max(100).nullable().optional(),
  active: z.boolean().optional(),
  excludedNumbers: z.array(z.string().max(40)).max(500).optional(),
});

const idParam = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);

const SEARCH_LIMIT = 1000;

/**
 * Transcript full-text search with role scope and filters applied in SQL, so the
 * LIMIT only counts calls this user may see. Mirrors callScope() in guards.ts.
 */
function searchCallIds(db: Deps["db"], user: User, q: z.infer<typeof ListQuery> & { q: string }) {
  const where: Prisma.Sql[] = [Prisma.sql`t."tsv" @@ websearch_to_tsquery('simple', ${q.q})`];
  if (user.role === "MANAGER" && user.team) where.push(Prisma.sql`u."team" = ${user.team}`);
  else if (user.role !== "ADMIN") where.push(Prisma.sql`c."user_id" = ${user.id}::uuid`);
  if (q.userId) where.push(Prisma.sql`c."user_id" = ${q.userId}::uuid`);
  if (q.direction) where.push(Prisma.sql`c."direction"::text = ${q.direction}`);
  if (q.status) where.push(Prisma.sql`c."status"::text = ${q.status}`);
  if (q.from) where.push(Prisma.sql`c."started_at" >= ${new Date(q.from)}`);
  if (q.to) where.push(Prisma.sql`c."started_at" <= ${new Date(q.to)}`);
  return db.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "transcripts" t
    JOIN "calls" c ON c."id" = t."call_id"
    JOIN "users" u ON u."id" = c."user_id"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY c."started_at" DESC
    LIMIT ${SEARCH_LIMIT}`;
}

/** JSON for the web dashboard (session cookie). */
export async function dashboardRoutes(app: FastifyInstance, deps: Deps) {
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };

  /** Fire-and-forget audit write; failures are logged, never crash the request. */
  const audit = (req: FastifyRequest, action: AuditAction, callId?: string, detail?: object) =>
    deps.db.auditLog
      .create({
        data: { userId: req.user?.id ?? null, action, callId: callId ?? null, detail: detail ?? undefined, ip: req.ip },
      })
      .catch((err: unknown) => req.log.error({ err, action }, "audit write failed"));

  app.get("/api/me", anyone, async (req) => {
    const u = currentUser(req);
    return { id: u.id, email: u.email, name: u.name, role: u.role, team: u.team, pictureUrl: u.pictureUrl };
  });

  /** The call list's filters (role scope, fields, transcript search) as a Prisma where. Audits searches. */
  const listWhere = async (req: FastifyRequest, q: z.infer<typeof ListQuery>): Promise<Prisma.CallWhereInput> => {
    const where: Prisma.CallWhereInput = { AND: [callScope(currentUser(req))] };
    const and = where.AND as Prisma.CallWhereInput[];
    if (q.userId) and.push({ userId: q.userId });
    if (q.direction) and.push({ direction: q.direction });
    if (q.status) and.push({ status: q.status });
    if (q.phone) and.push({ phoneE164: { contains: q.phone.replace(/[^\d+]/g, "") } });
    if (q.from || q.to) {
      and.push({ startedAt: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } });
    }
    if (q.q) {
      const hits = await searchCallIds(deps.db, currentUser(req), { ...q, q: q.q });
      and.push({ id: { in: hits.map((h) => h.id) } });
      audit(req, "SEARCH", undefined, { q: q.q });
    }
    return where;
  };

  app.get("/api/calls", anyone, async (req) => {
    const q = ListQuery.parse(req.query);
    const where = await listWhere(req, q);
    const rows = await deps.db.call.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        phoneE164: true,
        phoneRaw: true,
        contactName: true,
        direction: true,
        startedAt: true,
        durationS: true,
        status: true,
        user: { select: { id: true, name: true, email: true } },
        transcript: { select: { language: true } },
      },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items, nextCursor: more ? items.at(-1)?.id : null };
  });

  /**
   * CSV of the filtered call list with summaries and transcripts (same filters as /api/calls, newest first,
   * at most EXPORT_MAX_ROWS). Managers and admins only; every export is audit-logged.
   */
  app.get("/api/calls/export", managers, async (req, reply) => {
    const q = ListQuery.omit({ cursor: true, limit: true }).parse(req.query);
    const where = await listWhere(req, { ...q, limit: EXPORT_MAX_ROWS });
    const rows = await deps.db.call.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: EXPORT_MAX_ROWS,
      select: {
        id: true,
        startedAt: true,
        direction: true,
        phoneE164: true,
        phoneRaw: true,
        contactName: true,
        durationS: true,
        status: true,
        user: { select: { name: true, email: true } },
        transcript: {
          select: { language: true, text: true, textEn: true, summary: true, actionItems: true, sentiment: true, tags: true },
        },
      },
    });
    await audit(req, "EXPORT", undefined, { rows: rows.length, filters: { ...q, q: q.q ? "(search)" : undefined } });
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="calls-${stamp}.csv"`);
    reply.header("cache-control", "private, no-store");
    return callsCsv(rows);
  });

  app.get("/api/calls/:id", anyone, async (req) => {
    const call = await deps.db.call.findFirst({
      where: { AND: [{ id: idParam(req) }, callScope(currentUser(req))] },
      include: {
        user: { select: { id: true, name: true, email: true } },
        transcript: {
          select: {
            text: true,
            language: true,
            provider: true,
            segments: true,
            textEn: true,
            translationModel: true,
            summary: true,
            actionItems: true,
            sentiment: true,
            tags: true,
            speakerRoles: true,
            summaryModel: true,
          },
        },
      },
    });
    if (!call) throw new HttpError(404, "Not found");
    const open = call.transcript
      ? await deps.db.job.groupBy({
          by: ["kind"],
          where: { callId: call.id, kind: { in: ["translate", "summarize"] }, status: { in: ["QUEUED", "RUNNING"] } },
          _count: true,
        })
      : [];
    const pending = (kind: string) => open.some((g) => g.kind === kind);
    const transcript = call.transcript
      ? { ...call.transcript, translationPending: pending("translate"), summaryPending: pending("summarize") }
      : null;
    return { ...call, transcript, fileSize: call.fileSize?.toString() ?? null };
  });

  /** Audio playback with HTTP Range support (seeking in the browser player). `?download=1` saves the file (audited). */
  app.get("/api/calls/:id/audio", anyone, async (req, reply) => {
    const call = await deps.db.call.findFirst({
      where: { AND: [{ id: idParam(req) }, callScope(currentUser(req))] },
      select: { id: true, filePath: true, mimeType: true },
    });
    if (!call?.filePath) throw new HttpError(404, "No audio");
    const size = await deps.storage.size(call.filePath);
    reply.header("accept-ranges", "bytes");
    reply.header("content-type", call.mimeType ?? "application/octet-stream");
    reply.header("cache-control", "private, no-store");
    const { download } = z.object({ download: z.enum(["1", "true"]).optional() }).parse(req.query);
    if (download) {
      const ext = call.filePath.slice(call.filePath.lastIndexOf(".")).replace(/[^.\w]/g, "");
      reply.header("content-disposition", `attachment; filename="call-${call.id}${ext}"`);
      audit(req, "DOWNLOAD", call.id);
      reply.header("content-length", size);
      return reply.send(deps.storage.read(call.filePath));
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      // Browsers start playback with "bytes=0-"; seeks use later offsets.
      if (start === 0) audit(req, "PLAY", call.id);
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(deps.storage.read(call.filePath, { start, end }));
    }
    audit(req, "PLAY", call.id);
    reply.header("content-length", size);
    return reply.send(deps.storage.read(call.filePath));
  });

  app.delete("/api/calls/:id", admins, async (req, reply) => {
    const call = await deps.db.call.findUnique({ where: { id: idParam(req) } });
    if (!call) throw new HttpError(404, "Not found");
    if (call.filePath) await deps.storage.remove(call.filePath);
    await deps.db.call.delete({ where: { id: call.id } });
    await audit(req, "DELETE", undefined, { callId: call.id, userId: call.userId, startedAt: call.startedAt });
    return reply.code(204).send();
  });

  // ---- Users & devices --------------------------------------------------

  app.get("/api/users", managers, async () => {
    const users = await deps.db.user.findMany({
      orderBy: { email: "asc" },
      include: { _count: { select: { calls: true } } },
    });
    return users.map(({ googleSub: _s, ...u }) => u);
  });

  app.post("/api/users", admins, async (req, reply) => {
    const body = UserBody.parse(req.body);
    const exists = await deps.db.user.findUnique({ where: { email: body.email } });
    if (exists) throw new HttpError(409, "User already exists");
    const user = await deps.db.user.create({ data: { ...body, name: body.name ?? null, team: body.team ?? null } });
    await audit(req, "USER_CHANGE", undefined, { created: user.email, role: user.role });
    return reply.code(201).send(user);
  });

  app.patch("/api/users/:id", admins, async (req) => {
    const id = idParam(req);
    const body = UserPatch.parse(req.body);
    if (id === currentUser(req).id && (body.active === false || (body.role && body.role !== "ADMIN"))) {
      throw new HttpError(400, "You can't demote or deactivate yourself");
    }
    const user = await deps.db.user.update({ where: { id }, data: body });
    if (body.active === false) {
      // Deactivation kills app sessions right away.
      const devices = await deps.db.device.findMany({ where: { userId: id, revokedAt: null } });
      for (const d of devices) await deps.tokens.revokeDevice(d.id);
    }
    await audit(req, "USER_CHANGE", undefined, { userId: id, ...body });
    return user;
  });

  app.get("/api/devices", managers, async () => {
    const devices = await deps.db.device.findMany({
      orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return devices.map((d) => ({
      ...d,
      freeBytes: d.freeBytes?.toString() ?? null,
      // Derived flags (additive) so the dashboard and the app show the same warnings.
      standbyBucketName: bucketName(d.standbyBucket),
      throttled: isThrottled(d),
      callsWithoutRecordings: callsWithoutRecordings(d),
    }));
  });

  app.post("/api/devices/:id/revoke", admins, async (req, reply) => {
    const id = idParam(req);
    await deps.tokens.revokeDevice(id);
    await audit(req, "DEVICE_REVOKE", undefined, { deviceId: id });
    return reply.code(204).send();
  });

  // ---- Settings & health ------------------------------------------------

  app.get("/api/settings", admins, async () => getSettings(deps.db));

  /** Queues English translation for every transcript that doesn't have one yet. */
  app.post("/api/admin/translate-backfill", admins, async (req) => {
    const queued = await queueTranslationBackfill(deps.db);
    req.log.info({ queued, by: currentUser(req).id }, "translate backfill queued");
    return { queued };
  });

  /** Queues an AI summary for every transcript that doesn't have one yet (counts toward the Claude cap). */
  app.post("/api/admin/summarize-backfill", admins, async (req) => {
    const queued = await queueSummaryBackfill(deps.db);
    req.log.info({ queued, by: currentUser(req).id }, "summary backfill queued");
    return { queued };
  });

  /** Queues compression of large transcribed recordings, oldest first; `limit` (e.g. 5) for a trial run. */
  app.post("/api/admin/compress-backfill", admins, async (req) => {
    const { limit } = z.object({ limit: z.number().int().min(1).max(100_000).optional() }).parse(req.body ?? {});
    const queued = await queueCompressionBackfill(deps.db, limit);
    req.log.info({ queued, limit, by: currentUser(req).id }, "compress backfill queued");
    return { queued };
  });

  app.get("/api/compression", managers, async () => compressionStats(deps.db));

  /** Posts a test message to the Zoho Cliq channel (bypasses dedupe). */
  app.post("/api/admin/test-alert", admins, async (req) => {
    const url = deps.config.CLIQ_WEBHOOK_URL;
    if (!url) throw new HttpError(409, "Alerts are off: CLIQ_WEBHOOK_URL is not set on the server");
    const by = currentUser(req);
    const ok = await cliqSender(url, (m) => req.log.warn(m))(`Test alert from UIC Recorder, sent by ${by.name ?? by.email}.`);
    if (!ok) throw new HttpError(502, "Zoho Cliq did not accept the message; check the webhook URL");
    return { sent: true };
  });

  app.get("/api/translation/usage", managers, async () => translationUsage(deps.db));

  /** Claude monthly cap + Sarvam overflow switch. Raising the cap lets QUEUED translate jobs run on the next claim. */
  app.put("/api/settings/costs", admins, async (req) => {
    const patch = CostSettings.partial().parse(req.body);
    const current = await getCostSettings(deps.db);
    await saveCostSettings(deps.db, { ...current, ...patch });
    req.log.info({ patch, by: currentUser(req).id }, "cost settings changed");
    await audit(req, "SETTINGS_CHANGE", undefined, { costs: patch });
    return translationUsage(deps.db);
  });

  // ---- Privacy: retention, PII masking, client list, audit log ------------

  app.get("/api/settings/privacy", admins, async () => getPrivacySettings(deps.db));

  /** Retention (null = keep forever) and PII masking. Both default off. */
  app.put("/api/settings/privacy", admins, async (req) => {
    const patch = PrivacySettings.partial().parse(req.body);
    const current = await getPrivacySettings(deps.db);
    const next = { ...current, ...patch };
    await savePrivacySettings(deps.db, next);
    await audit(req, "SETTINGS_CHANGE", undefined, { privacy: patch });
    return next;
  });

  app.get("/api/client-numbers", admins, async () => {
    const rows = await deps.db.clientNumber.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, raw: true, label: true, createdAt: true } });
    return { items: rows, count: rows.length };
  });

  app.post("/api/client-numbers", admins, async (req, reply) => {
    const body = ClientNumberBody.parse(req.body);
    const key = numberKey(body.number);
    if (key.length < MIN_KEY_DIGITS) throw new HttpError(400, `Enter a phone number with at least ${MIN_KEY_DIGITS} digits`);
    const row = { key, raw: body.number, label: body.label || null };
    const exists = await deps.db.clientNumber.findUnique({ where: { key: row.key } });
    if (exists) throw new HttpError(409, `Already on the client list as ${exists.raw}`);
    if ((await deps.db.clientNumber.count()) >= MAX_CLIENT_NUMBERS) throw new HttpError(409, "Client list is full");
    const created = await deps.db.clientNumber.create({ data: row, select: { id: true, raw: true, label: true, createdAt: true } });
    await audit(req, "CLIENT_LIST_CHANGE", undefined, { added: 1 });
    return reply.code(201).send(created);
  });

  /** CSV import: one number per line, optional label after the first comma. Existing numbers are kept. */
  app.post("/api/client-numbers/import", { ...admins, bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const { csv } = z.object({ csv: z.string().max(10 * 1024 * 1024) }).parse(req.body);
    const { rows, rejected } = parseClientCsv(csv);
    if ((await deps.db.clientNumber.count()) + rows.length > MAX_CLIENT_NUMBERS) throw new HttpError(409, "Client list would be too large");
    const r = await importClientNumbers(deps.db, rows);
    await audit(req, "CLIENT_LIST_CHANGE", undefined, { imported: r.added, updated: r.updated, rejected: rejected.length });
    return { ...r, rejected: rejected.length, rejectedSample: rejected.slice(0, 10) };
  });

  app.delete("/api/client-numbers/:id", admins, async (req, reply) => {
    const id = idParam(req);
    const r = await deps.db.clientNumber.deleteMany({ where: { id } });
    if (r.count === 0) throw new HttpError(404, "Not found");
    await audit(req, "CLIENT_LIST_CHANGE", undefined, { removed: 1 });
    return reply.code(204).send();
  });

  /** Is this number on the client list? (admin check from the dashboard / app). */
  app.get("/api/client-numbers/check", admins, async (req) => {
    const { number } = z.object({ number: z.string().max(40) }).parse(req.query);
    const key = numberKey(number);
    return { onList: key.length > 0 && !!(await deps.db.clientNumber.findUnique({ where: { key } })) };
  });

  /** Newest first, keyset-paged. Admin only. */
  app.get("/api/audit", admins, async (req) => {
    const q = AuditQuery.parse(req.query);
    const rows = await deps.db.auditLog.findMany({
      where: { action: q.action, userId: q.userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items, nextCursor: more ? items.at(-1)?.id : null };
  });

  app.put("/api/settings/device-config", admins, async (req) => {
    const deviceConfig = DeviceConfig.parse(req.body);
    await deps.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig }, update: { deviceConfig } });
    await audit(req, "SETTINGS_CHANGE", undefined, { deviceConfig });
    return deviceConfig;
  });

  app.get("/api/stats", managers, async () => {
    const [byStatus, queue, disk, staleDevices, fireflies, rates, translation, compression] = await Promise.all([
      deps.db.call.groupBy({ by: ["status"], _count: true }),
      deps.db.job.groupBy({ by: ["status"], _count: true }),
      deps.storage.diskUsage(),
      deps.db.device.count({ where: { revokedAt: null, lastSeenAt: { lt: new Date(Date.now() - 24 * 3600_000) } } }),
      firefliesUsage(deps.db),
      throughput(deps.db),
      translationUsage(deps.db),
      compressionStats(deps.db),
    ]);
    return {
      calls: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
      jobs: Object.fromEntries(queue.map((r) => [r.status, r._count])),
      disk: { ...disk, usedPct: Math.round((1 - disk.freeBytes / disk.totalBytes) * 100) },
      staleDevices,
      // Throughput + backlog ETA (additive).
      throughput: rates,
      alertsEnabled: !!deps.config.CLIQ_WEBHOOK_URL,
      // Claude translation spend vs. its monthly cap (additive).
      translation: {
        month: translation.month,
        spentUsd: translation.spentUsd,
        budgetUsd: translation.budgetUsd,
        pct: translation.pct,
        capped: translation.capped,
      },
      // Disk freed by re-encoding old recordings (additive).
      compression,
      // Banner state for the dashboard / app (additive).
      fireflies: {
        month: fireflies.month,
        pct: fireflies.pct,
        thresholds: fireflies.thresholds,
        blocked: fireflies.blocked,
        lastError: fireflies.lastError,
        backlogGateReached: fireflies.backlogSent >= fireflies.approvedBacklogCount,
        waitingBudgetJobs: fireflies.waitingBudgetJobs,
      },
    };
  });
}
