import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { callScope, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import { Prisma, type AuditAction, type User } from "../generated/prisma/client.js";
import { DeviceConfig, getSettings } from "../settings.js";
import { firefliesUsage } from "../fireflies/budget.js";

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

  app.get("/api/calls", anyone, async (req) => {
    const q = ListQuery.parse(req.query);
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

  app.get("/api/calls/:id", anyone, async (req) => {
    const call = await deps.db.call.findFirst({
      where: { AND: [{ id: idParam(req) }, callScope(currentUser(req))] },
      include: {
        user: { select: { id: true, name: true, email: true } },
        transcript: { select: { text: true, language: true, provider: true, segments: true } },
      },
    });
    if (!call) throw new HttpError(404, "Not found");
    return { ...call, fileSize: call.fileSize?.toString() ?? null };
  });

  /** Audio playback with HTTP Range support (seeking in the browser player). */
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
    return devices.map((d) => ({ ...d, freeBytes: d.freeBytes?.toString() ?? null }));
  });

  app.post("/api/devices/:id/revoke", admins, async (req, reply) => {
    const id = idParam(req);
    await deps.tokens.revokeDevice(id);
    await audit(req, "DEVICE_REVOKE", undefined, { deviceId: id });
    return reply.code(204).send();
  });

  // ---- Settings & health ------------------------------------------------

  app.get("/api/settings", admins, async () => getSettings(deps.db));

  app.put("/api/settings/device-config", admins, async (req) => {
    const deviceConfig = DeviceConfig.parse(req.body);
    await deps.db.setting.upsert({ where: { id: 1 }, create: { id: 1, deviceConfig }, update: { deviceConfig } });
    return deviceConfig;
  });

  app.get("/api/stats", managers, async () => {
    const [byStatus, queue, disk, staleDevices, fireflies] = await Promise.all([
      deps.db.call.groupBy({ by: ["status"], _count: true }),
      deps.db.job.groupBy({ by: ["status"], _count: true }),
      deps.storage.diskUsage(),
      deps.db.device.count({ where: { revokedAt: null, lastSeenAt: { lt: new Date(Date.now() - 24 * 3600_000) } } }),
      firefliesUsage(deps.db),
    ]);
    return {
      calls: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
      jobs: Object.fromEntries(queue.map((r) => [r.status, r._count])),
      disk: { ...disk, usedPct: Math.round((1 - disk.freeBytes / disk.totalBytes) * 100) },
      staleDevices,
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
