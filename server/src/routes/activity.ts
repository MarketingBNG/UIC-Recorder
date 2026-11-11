import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { callScope, requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import type { Prisma, User } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import {
  ActivityBody,
  OUTCOMES,
  activityDto,
  addActivity,
  existingActivity,
  contactDto,
  contactInclude,
  contactScope,
  istDay,
  repContactScope,
  upsertContact,
  validateActivity,
} from "../activity/service.js";

const STATUSES = ["NEW", ...OUTCOMES] as const;
const TIMELINE_MAX = 200;

const idParam = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);

const DeviceListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const DashListQuery = DeviceListQuery.extend({
  ownerId: z.uuid().optional(),
  status: z.enum(STATUSES).optional(),
  due: z.enum(["today", "overdue"]).optional(),
});
const NameFields = {
  name: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
};
const DevicePatch = z.object(NameFields);
const DashPatch = z.object({
  ...NameFields,
  status: z.enum(STATUSES).optional(),
  nextFollowUpAt: z.iso.datetime({ offset: true }).nullable().optional(),
  ownerId: z.uuid().optional(),
});
const NoteBody = z.object({
  note: z.string().trim().min(1).max(2000),
  followUpAt: z.iso.datetime({ offset: true }).optional(),
});
const RangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** name/company/phone search; digits in q also match the stored number. */
function searchWhere(q: string | undefined): Prisma.ContactWhereInput {
  if (!q) return {};
  const or: Prisma.ContactWhereInput[] = [
    { name: { contains: q, mode: "insensitive" } },
    { company: { contains: q, mode: "insensitive" } },
  ];
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3) or.push({ phoneE164: { contains: digits } });
  return { OR: or };
}

const listOrder: Prisma.ContactOrderByWithRelationInput[] = [
  { lastActivityAt: { sort: "desc", nulls: "last" } },
  { id: "desc" },
];

/** Blank strings clear a field; undefined leaves it. */
const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v || null);

/** Activity tracker: phone dialer API (Bearer) and dashboard API (session). See docs/dialer-plan.md. */
export async function activityRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const region = deps.config.DEFAULT_PHONE_REGION;

  const findContact = async (where: Prisma.ContactWhereInput) => {
    const c = await deps.db.contact.findFirst({ where, include: contactInclude });
    if (!c) throw new HttpError(404, "Contact not found");
    return c;
  };

  // ---- Phone app ----

  /** Stores one activity from the phone (idempotent by clientId). Throws HttpError for a bad item. */
  const saveFromPhone = async (userId: string, body: z.infer<typeof ActivityBody>) => {
    const phoneE164 = toE164(body.phone, region);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    const followUpAt = body.followUpAt ? new Date(body.followUpAt) : undefined;
    validateActivity({ type: body.type, outcome: body.outcome, followUpAt });
    // Retry of an already stored activity: return it without touching the contact (409 if not this rep's).
    const prior = await existingActivity(deps, body.clientId, userId);
    return (
      prior ??
      (await addActivity(deps, userId, (await upsertContact(deps, phoneE164, userId, body.name, body.company)).id, {
        clientId: body.clientId,
        type: body.type,
        outcome: body.outcome,
        note: body.note,
        followUpAt,
        durationS: body.durationS,
        occurredAt: new Date(body.occurredAt),
      }))
    );
  };

  app.post("/v1/activities", device, async (req) => {
    const activity = await saveFromPhone(currentUser(req).id, ActivityBody.parse(req.body));
    const fresh = await deps.db.contact.findUniqueOrThrow({ where: { id: activity.contactId }, include: contactInclude });
    const { callId: _callId, ...dto } = activityDto(activity);
    return { activity: dto, contact: contactDto(fresh) };
  });

  /**
   * Up to 50 queued activities in one request (after an outage the phone may hold many). Stored in the order
   * sent, so a contact ends in the state of its newest outcome. Each item succeeds or fails on its own; an item
   * that fails validation is reported with its status and does not stop the rest.
   */
  app.post("/v1/activities/batch", device, async (req) => {
    const raw = z.object({ items: z.array(z.unknown()).min(1).max(50) }).parse(req.body).items;
    const userId = currentUser(req).id;
    const results = [];
    for (const item of raw) {
      const parsed = ActivityBody.safeParse(item);
      const clientId = typeof (item as { clientId?: unknown })?.clientId === "string" ? (item as { clientId: string }).clientId : null;
      if (!parsed.success) {
        results.push({ clientId, ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Invalid activity" });
        continue;
      }
      try {
        await saveFromPhone(userId, parsed.data);
        results.push({ clientId, ok: true });
      } catch (e) {
        if (!(e instanceof HttpError) || e.statusCode >= 500) throw e; // server trouble: the phone retries the batch
        results.push({ clientId, ok: false, status: e.statusCode, error: e.message });
      }
    }
    return { results };
  });

  app.get("/v1/contacts", device, async (req) => {
    const q = DeviceListQuery.parse(req.query);
    const rows = await deps.db.contact.findMany({
      where: { AND: [repContactScope(currentUser(req).id), searchWhere(q.q)] },
      orderBy: listOrder,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: contactInclude,
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: items.map(contactDto), nextCursor: more ? items.at(-1)!.id : null };
  });

  app.get("/v1/contacts/followups", device, async (req) => {
    const { end } = istDay();
    const rows = await deps.db.contact.findMany({
      where: { AND: [repContactScope(currentUser(req).id), { nextFollowUpAt: { lt: end } }] },
      orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
      take: 500,
      include: contactInclude,
    });
    return { items: rows.map(contactDto) };
  });

  app.get("/v1/contacts/by-phone", device, async (req) => {
    const { phone } = z.object({ phone: z.string().trim().min(1).max(40) }).parse(req.query);
    const phoneE164 = toE164(phone, region);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    const contact = await deps.db.contact.findFirst({
      where: { AND: [{ phoneE164 }, repContactScope(currentUser(req).id)] },
      include: contactInclude,
    });
    if (!contact) return { contact: null, activities: [] };
    const activities = await deps.db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    return { contact: contactDto(contact), activities: activities.map(activityDto) };
  });

  app.patch("/v1/contacts/:id", device, async (req) => {
    const id = idParam(req);
    const body = DevicePatch.parse(req.body);
    await findContact({ AND: [{ id }, repContactScope(currentUser(req).id)] });
    const c = await deps.db.contact.update({
      where: { id },
      data: { name: blankToNull(body.name), company: blankToNull(body.company) },
      include: contactInclude,
    });
    return contactDto(c);
  });

  // ---- Dashboard ----

  app.get("/api/contacts", anyone, async (req) => {
    const q = DashListQuery.parse(req.query);
    const { start, end } = istDay();
    const and: Prisma.ContactWhereInput[] = [contactScope(currentUser(req)), searchWhere(q.q)];
    if (q.ownerId) and.push({ ownerId: q.ownerId });
    if (q.status) and.push({ status: q.status });
    if (q.due === "overdue") and.push({ nextFollowUpAt: { lt: start } });
    if (q.due === "today") and.push({ nextFollowUpAt: { gte: start, lt: end } });
    const rows = await deps.db.contact.findMany({
      where: { AND: and },
      orderBy: listOrder,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { ...contactInclude, _count: { select: { activities: true } } },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return {
      items: items.map((c) => ({ ...contactDto(c), activityCount: c._count.activities })),
      nextCursor: more ? items.at(-1)!.id : null,
    };
  });

  app.get("/api/contacts/:id", anyone, async (req) => {
    const user = currentUser(req);
    const contact = await findContact({ AND: [{ id: idParam(req) }, contactScope(user)] });
    const activities = await deps.db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: TIMELINE_MAX,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    const linkedIds = activities.flatMap((a) => (a.callId ? [a.callId] : []));
    // Calls on this number plus calls linked to these activities, limited to what the viewer may see.
    const calls = await deps.db.call.findMany({
      where: { AND: [callScope(user), { OR: [{ phoneE164: contact.phoneE164 }, { id: { in: linkedIds } }] }] },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: TIMELINE_MAX + linkedIds.length,
      select: {
        id: true,
        direction: true,
        startedAt: true,
        durationS: true,
        status: true,
        filePath: true,
        audioDeletedAt: true,
        user: { select: { id: true, name: true, email: true } },
        transcript: { select: { summary: true } },
      },
    });
    const callFields = (c: (typeof calls)[number]) => ({
      id: c.id,
      status: c.status,
      summary: c.transcript?.summary ?? null,
      hasAudio: !!c.filePath && !c.audioDeletedAt,
    });
    const byId = new Map(calls.map((c) => [c.id, c]));
    const linked = new Set(linkedIds);
    const items = [
      ...activities.map((a) => {
        const call = a.callId ? byId.get(a.callId) : undefined;
        return { kind: "activity" as const, ...activityDto(a), user: a.user, call: call ? callFields(call) : null, at: a.occurredAt };
      }),
      ...calls
        .filter((c) => !linked.has(c.id))
        .map((c) => {
          const { id, status, summary, hasAudio } = callFields(c);
          return { kind: "call" as const, id, direction: c.direction, startedAt: c.startedAt, durationS: c.durationS, status, user: c.user, hasAudio, summary, at: c.startedAt };
        }),
    ];
    items.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { contact: contactDto(contact), timeline: items.slice(0, TIMELINE_MAX).map(({ at: _at, ...rest }) => rest) };
  });

  app.patch("/api/contacts/:id", anyone, async (req) => {
    const user = currentUser(req);
    const id = idParam(req);
    const body = DashPatch.parse(req.body);
    await findContact({ AND: [{ id }, contactScope(user)] });
    if (body.ownerId !== undefined) {
      if (user.role === "AGENT") throw new HttpError(403, "Only managers can change the owner");
      const owner = await deps.db.user.findUnique({ where: { id: body.ownerId } });
      if (!owner) throw new HttpError(400, "Unknown owner");
      if (user.role === "MANAGER" && (!user.team || owner.team !== user.team) && owner.id !== user.id) {
        throw new HttpError(403, "Owner must be in your team");
      }
    }
    const c = await deps.db.contact.update({
      where: { id },
      data: {
        name: blankToNull(body.name),
        company: blankToNull(body.company),
        status: body.status,
        nextFollowUpAt: body.nextFollowUpAt === undefined ? undefined : body.nextFollowUpAt && new Date(body.nextFollowUpAt),
        ownerId: body.ownerId,
      },
      include: contactInclude,
    });
    return contactDto(c);
  });

  app.post("/api/contacts/:id/notes", anyone, async (req) => {
    const user = currentUser(req);
    const contact = await findContact({ AND: [{ id: idParam(req) }, contactScope(user)] });
    const body = NoteBody.parse(req.body);
    const a = await addActivity(deps, user.id, contact.id, {
      type: "NOTE",
      note: body.note,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : undefined,
      occurredAt: new Date(),
    });
    return activityDto(a);
  });

  app.get("/api/activity/reps", managers, async (req) => {
    const q = RangeQuery.parse(req.query);
    const today = istDay();
    const from = q.from ? new Date(q.from) : today.start;
    const to = q.to ? new Date(q.to) : today.end;
    const users = await deps.db.user.findMany({
      where: { active: true, ...repUserScope(currentUser(req)) },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });
    const ids = users.map((u) => u.id);
    const [acts, dueToday, overdue] = await Promise.all([
      deps.db.activity.findMany({
        where: { userId: { in: ids }, type: { in: ["CALL", "WHATSAPP"] }, occurredAt: { gte: from, lt: to } },
        select: { userId: true, type: true, outcome: true, durationS: true },
      }),
      deps.db.contact.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: ids }, nextFollowUpAt: { gte: today.start, lt: today.end } },
        _count: { _all: true },
      }),
      deps.db.contact.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: ids }, nextFollowUpAt: { lt: today.start } },
        _count: { _all: true },
      }),
    ]);
    const countOf = (rows: typeof dueToday, id: string) => rows.find((r) => r.ownerId === id)?._count._all ?? 0;
    const items = users.map((u) => {
      const mine = acts.filter((a) => a.userId === u.id);
      const calls = mine.filter((a) => a.type === "CALL");
      return {
        user: u,
        callsMade: calls.length,
        // The call log's duration decides when the phone gave one (0 s = never connected, whatever the rep
        // picked, e.g. Call back after no answer); only without a duration does the outcome decide.
        answered: calls.filter((a) =>
          a.durationS != null ? a.durationS > 0 : a.outcome !== null && a.outcome !== "NO_ANSWER",
        ).length,
        talkTimeS: calls.reduce((s, a) => s + (a.durationS ?? 0), 0),
        whatsapp: mine.length - calls.length,
        followUpsDueToday: countOf(dueToday, u.id),
        overdue: countOf(overdue, u.id),
      };
    });
    return { items };
  });
}

/** Reps a manager sees in the per-rep view: ADMIN everyone, MANAGER their team (or just themselves without one). */
function repUserScope(user: User): Prisma.UserWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.team) return { team: user.team };
  return { id: user.id };
}
