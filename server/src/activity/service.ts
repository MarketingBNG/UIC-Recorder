import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import { Prisma, type ActivityType, type CallOutcome, type User } from "../generated/prisma/client.js";

/** A CALL activity and a recorded Call belong together when same rep, same number, start within this window. */
export const LINK_WINDOW_MS = 10 * 60 * 1000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** Start and end (exclusive) of the Asia/Kolkata calendar day containing `now`. IST has no DST. */
export function istDay(now = new Date()): { start: Date; end: Date } {
  const start = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export const OUTCOMES = ["INTERESTED", "CALL_BACK", "NOT_INTERESTED", "NO_ANSWER"] as const;

export const ActivityBody = z.object({
  clientId: z.uuid(),
  phone: z.string().trim().min(1).max(40),
  type: z.enum(["CALL", "WHATSAPP", "NOTE"]),
  outcome: z.enum(OUTCOMES).optional(),
  note: z.string().trim().max(2000).optional(),
  followUpAt: z.iso.datetime({ offset: true }).optional(),
  durationS: z.number().int().min(0).max(24 * 3600).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;

const userSelect = { id: true, name: true, email: true } as const;
export const contactInclude = { owner: { select: userSelect } } as const;
type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;
type ActivityRow = Prisma.ActivityGetPayload<object>;

export function contactDto(c: ContactRow) {
  return {
    id: c.id,
    phoneE164: c.phoneE164,
    name: c.name,
    company: c.company,
    status: c.status,
    nextFollowUpAt: c.nextFollowUpAt,
    lastActivityAt: c.lastActivityAt,
    owner: c.owner,
  };
}

export function activityDto(a: ActivityRow) {
  return {
    id: a.id,
    clientId: a.clientId,
    type: a.type,
    outcome: a.outcome,
    note: a.note,
    followUpAt: a.followUpAt,
    durationS: a.durationS,
    occurredAt: a.occurredAt,
    callId: a.callId,
  };
}

/** Contacts a rep works with: owned, or with any activity of theirs. */
export function repContactScope(userId: string): Prisma.ContactWhereInput {
  return { OR: [{ ownerId: userId }, { activities: { some: { userId } } }] };
}

/** Which contacts a dashboard user may see. Mirrors callScope() in auth/guards.ts. */
export function contactScope(user: User): Prisma.ContactWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.role === "MANAGER" && user.team) return { owner: { team: user.team } };
  return repContactScope(user.id);
}

/** The user's recorded call on this number closest to `at` (within the window) that no activity has claimed yet. */
async function findCallFor(db: Deps["db"], userId: string, phoneE164: string, at: Date) {
  const calls = await db.call.findMany({
    where: {
      userId,
      phoneE164,
      startedAt: { gte: new Date(at.getTime() - LINK_WINDOW_MS), lte: new Date(at.getTime() + LINK_WINDOW_MS) },
      activities: { none: {} },
    },
    select: { id: true, startedAt: true },
  });
  return closest(calls, (c) => c.startedAt, at)?.id ?? null;
}

function closest<T>(rows: T[], time: (r: T) => Date, at: Date): T | undefined {
  return rows.sort((a, b) => Math.abs(time(a).getTime() - at.getTime()) - Math.abs(time(b).getTime() - at.getTime()))[0];
}

/** After a Call is registered: link it to the closest unlinked CALL activity by the same rep on the same number. */
export async function linkCallToActivity(deps: Deps, call: { id: string; userId: string; phoneE164: string | null; startedAt: Date }) {
  if (!call.phoneE164) return;
  if ((await deps.db.activity.count({ where: { callId: call.id } })) > 0) return;
  const at = call.startedAt;
  const candidates = await deps.db.activity.findMany({
    where: {
      userId: call.userId,
      type: "CALL",
      callId: null,
      contact: { phoneE164: call.phoneE164 },
      occurredAt: { gte: new Date(at.getTime() - LINK_WINDOW_MS), lte: new Date(at.getTime() + LINK_WINDOW_MS) },
    },
    select: { id: true, occurredAt: true },
  });
  const best = closest(candidates, (a) => a.occurredAt, at);
  if (best) await deps.db.activity.updateMany({ where: { id: best.id, callId: null }, data: { callId: call.id } });
}

export interface NewActivity {
  clientId?: string;
  type: ActivityType;
  outcome?: CallOutcome | undefined;
  note?: string | undefined;
  followUpAt?: Date | undefined;
  durationS?: number | undefined;
  occurredAt: Date;
}

/** Contact changes implied by a new activity (see docs/dialer-plan.md). */
function contactUpdate(contact: { lastActivityAt: Date | null }, a: NewActivity): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {};
  if (!contact.lastActivityAt || contact.lastActivityAt < a.occurredAt) data.lastActivityAt = a.occurredAt;
  // An older activity synced late (offline phone) must not overwrite newer status/follow-up.
  if (contact.lastActivityAt && a.occurredAt < contact.lastActivityAt) return data;
  if (a.type === "CALL" && a.outcome) {
    data.status = a.outcome;
    data.nextFollowUpAt = a.outcome === "CALL_BACK" ? a.followUpAt! : null;
  } else if (a.type === "NOTE" && a.followUpAt) {
    data.status = "CALL_BACK";
    data.nextFollowUpAt = a.followUpAt;
  }
  return data;
}

/** Creates the activity, updates its contact, and links a matching recorded call. Idempotent on clientId. */
export function validateActivity(a: Pick<NewActivity, "type" | "outcome" | "followUpAt">) {
  if (a.outcome && a.type !== "CALL") throw new HttpError(400, "outcome is only for CALL activities");
  if (a.outcome === "CALL_BACK" && !a.followUpAt) throw new HttpError(400, "CALL_BACK needs followUpAt");
}

/** The activity already stored under this clientId (null if none); 409 if another user owns it. */
export async function existingActivity(deps: Deps, clientId: string, userId: string) {
  const existing = await deps.db.activity.findUnique({ where: { clientId } });
  return existing ? sameOwner(existing, userId) : null;
}

export async function addActivity(deps: Deps, userId: string, contactId: string, a: NewActivity) {
  validateActivity(a);
  const clientId = a.clientId ?? randomUUID();
  const existing = await existingActivity(deps, clientId, userId);
  if (existing) return existing;

  try {
    return await deps.db.$transaction(async (tx) => {
      // Row lock serialises activities on one contact: no lost contact update, no Call claimed twice.
      await tx.$executeRaw`SELECT 1 FROM contacts WHERE id = ${contactId}::uuid FOR UPDATE`;
      const contact = await tx.contact.findUniqueOrThrow({ where: { id: contactId } });
      const callId = a.type === "CALL" ? await findCallFor(tx as Deps["db"], userId, contact.phoneE164, a.occurredAt) : null;
      const activity = await tx.activity.create({
        data: {
          clientId,
          contactId,
          userId,
          type: a.type,
          outcome: a.outcome ?? null,
          note: a.note || null,
          followUpAt: a.followUpAt ?? null,
          durationS: a.durationS ?? null,
          occurredAt: a.occurredAt,
          callId,
        },
      });
      await tx.contact.update({ where: { id: contactId }, data: contactUpdate(contact, a) });
      return activity;
    });
  } catch (e) {
    // A concurrent retry with the same clientId won the insert.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return sameOwner(await deps.db.activity.findUniqueOrThrow({ where: { clientId } }), userId);
    }
    throw e;
  }
}

function sameOwner(a: ActivityRow, userId: string) {
  if (a.userId !== userId) throw new HttpError(409, "clientId already used");
  return a;
}

/** Finds or creates the contact for a number; the first rep to log an activity owns it. */
export async function upsertContact(deps: Deps, phoneE164: string, ownerId: string, name?: string, company?: string) {
  const fields = { ...(name ? { name } : {}), ...(company ? { company } : {}) };
  const upsert = () =>
    deps.db.contact.upsert({ where: { phoneE164 }, create: { phoneE164, ownerId, ...fields }, update: fields });
  try {
    return await upsert();
  } catch (e) {
    // Two reps' first activity on a new number at the same moment: the loser retries as an update.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return upsert();
    throw e;
  }
}
