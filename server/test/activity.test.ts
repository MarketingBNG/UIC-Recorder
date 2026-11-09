import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { istDay } from "../src/activity/service.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

/** A random Indian mobile number (10 digits starting 9). */
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const iso = (d: Date) => d.toISOString();
const minutes = (n: number) => n * 60 * 1000;

async function post(headers: Record<string, string>, body: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/v1/activities",
    headers,
    payload: { clientId: randomUUID(), type: "CALL", occurredAt: iso(new Date()), ...body },
  });
}

async function registerCall(headers: Record<string, string>, phone: string, startedAt: Date) {
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    headers,
    payload: { originalSha256: sha256(randomUUID()), phoneNumber: phone, direction: "OUTGOING", startedAt: iso(startedAt), durationS: 60 },
  });
  return res.json().callId as string;
}

describe("istDay", () => {
  it("uses the Asia/Kolkata calendar day", () => {
    // 2026-11-08 20:00 UTC is 2026-11-09 01:30 IST.
    const { start, end } = istDay(new Date("2026-11-08T20:00:00Z"));
    expect(iso(start)).toBe("2026-11-08T18:30:00.000Z");
    expect(iso(end)).toBe("2026-11-09T18:30:00.000Z");
  });
});

describe("POST /v1/activities", () => {
  it("auto-creates the contact owned by the first rep and is idempotent on clientId", async () => {
    const a = await t.loginDevice(uniqueEmail("rep"));
    const b = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const clientId = randomUUID();
    const first = await post(a.headers, { clientId, phone, outcome: "INTERESTED", durationS: 40, name: "Asha", company: "Acme" });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.contact).toMatchObject({ phoneE164: `+91${phone}`, name: "Asha", company: "Acme", status: "INTERESTED", owner: { id: a.user.id } });
    expect(body.activity).toMatchObject({ clientId, type: "CALL", outcome: "INTERESTED", durationS: 40 });

    const again = await post(a.headers, { clientId, phone, outcome: "INTERESTED" });
    expect(again.statusCode).toBe(200);
    expect(again.json().activity.id).toBe(body.activity.id);
    expect(await t.db.activity.count({ where: { clientId } })).toBe(1);

    // A second rep's activity keeps the original owner and does not wipe the name.
    const other = await post(b.headers, { phone: `+91 ${phone}`, type: "WHATSAPP" });
    expect(other.json().contact).toMatchObject({ id: body.contact.id, name: "Asha", owner: { id: a.user.id }, status: "INTERESTED" });

    // The same clientId from another rep is a conflict, not a silent return of someone else's row.
    expect((await post(b.headers, { clientId, phone })).statusCode).toBe(409);
  });

  it("maps +91, 0-prefixed and 10-digit forms to one contact", async () => {
    const s = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const ids = new Set<string>();
    for (const p of [`+91${phone}`, `0${phone}`, phone, `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`]) {
      const res = await post(s.headers, { phone: p, type: "NOTE", note: "x" });
      expect(res.statusCode).toBe(200);
      ids.add(res.json().contact.id);
    }
    expect(ids.size).toBe(1);
    expect((await post(s.headers, { phone: "12" })).statusCode).toBe(400);
  });

  it("applies the status and follow-up rules", async () => {
    const s = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const later = new Date(Date.now() + 2 * 86400_000);

    expect((await post(s.headers, { phone, outcome: "CALL_BACK" })).statusCode).toBe(400);

    let c = (await post(s.headers, { phone, outcome: "CALL_BACK", followUpAt: iso(later) })).json().contact;
    expect(c).toMatchObject({ status: "CALL_BACK", nextFollowUpAt: iso(later) });

    // WhatsApp leaves status and follow-up alone.
    c = (await post(s.headers, { phone, type: "WHATSAPP" })).json().contact;
    expect(c).toMatchObject({ status: "CALL_BACK", nextFollowUpAt: iso(later) });

    // Any other call outcome clears the follow-up.
    c = (await post(s.headers, { phone, outcome: "NO_ANSWER" })).json().contact;
    expect(c).toMatchObject({ status: "NO_ANSWER", nextFollowUpAt: null });

    // A note with a follow-up date sets CALL_BACK.
    c = (await post(s.headers, { phone, type: "NOTE", note: "ring tuesday", followUpAt: iso(later) })).json().contact;
    expect(c).toMatchObject({ status: "CALL_BACK", nextFollowUpAt: iso(later) });

    // lastActivityAt never moves backwards for a late-synced older activity.
    const before = c.lastActivityAt;
    c = (await post(s.headers, { phone, type: "WHATSAPP", occurredAt: iso(new Date(Date.now() - 86400_000)) })).json().contact;
    expect(c.lastActivityAt).toBe(before);
  });
});

describe("device contact endpoints", () => {
  it("lists, finds by phone, lists follow-ups and patches within the rep scope", async () => {
    const a = await t.loginDevice(uniqueEmail("rep"));
    const b = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const due = new Date(Date.now() - minutes(5));
    const { contact } = (await post(a.headers, { phone, outcome: "CALL_BACK", followUpAt: iso(due), name: "Zed Unique" })).json();

    const list = (await t.app.inject({ url: "/v1/contacts?q=zed%20uni", headers: a.headers })).json();
    expect(list.items.map((c: { id: string }) => c.id)).toEqual([contact.id]);
    expect((await t.app.inject({ url: "/v1/contacts", headers: b.headers })).json().items).toEqual([]);

    const fu = (await t.app.inject({ url: "/v1/contacts/followups", headers: a.headers })).json();
    expect(fu.items.map((c: { id: string }) => c.id)).toContain(contact.id);

    const byPhone = (await t.app.inject({ url: `/v1/contacts/by-phone?phone=0${phone}`, headers: a.headers })).json();
    expect(byPhone.contact.id).toBe(contact.id);
    expect(byPhone.activities).toHaveLength(1);
    expect((await t.app.inject({ url: `/v1/contacts/by-phone?phone=${phone}`, headers: b.headers })).json()).toEqual({ contact: null, activities: [] });

    const patch = await t.app.inject({ method: "PATCH", url: `/v1/contacts/${contact.id}`, headers: a.headers, payload: { company: "NewCo", name: null } });
    expect(patch.json()).toMatchObject({ company: "NewCo", name: null });
    expect((await t.app.inject({ method: "PATCH", url: `/v1/contacts/${contact.id}`, headers: b.headers, payload: { name: "x" } })).statusCode).toBe(404);
  });
});

describe("call linking", () => {
  it("links an activity to an earlier-registered call and a later-registered call to an activity", async () => {
    const s = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const at = new Date(Date.now() - minutes(60));

    // Call first, then activity 3 minutes later; a call 20 minutes away is ignored.
    const far = await registerCall(s.headers, phone, new Date(at.getTime() - minutes(20)));
    const near = await registerCall(s.headers, phone, at);
    const act = (await post(s.headers, { phone, outcome: "INTERESTED", occurredAt: iso(new Date(at.getTime() + minutes(3))) })).json().activity;
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: act.id } })).callId).toBe(near);
    expect(far).not.toBe(near);

    // Activity first, then the recording is registered.
    const phone2 = randomMobile();
    const at2 = new Date(Date.now() - minutes(30));
    const act2 = (await post(s.headers, { phone: phone2, outcome: "NO_ANSWER", occurredAt: iso(at2) })).json().activity;
    const call2 = await registerCall(s.headers, `+91${phone2}`, new Date(at2.getTime() - minutes(2)));
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: act2.id } })).callId).toBe(call2);

    // Another rep's call on the same number is never linked.
    const other = await t.loginDevice(uniqueEmail("rep"));
    const otherCall = await registerCall(other.headers, phone2, at2);
    expect(await t.db.activity.count({ where: { callId: otherCall } })).toBe(0);
  });
});

describe("dashboard", () => {
  it("scopes /api/contacts by role", async () => {
    const team = `team-${randomUUID().slice(0, 6)}`;
    const agentEmail = uniqueEmail("agent");
    const outsiderEmail = uniqueEmail("agent");
    const managerEmail = uniqueEmail("mgr");
    const adminEmail = uniqueEmail("admin");
    const agent = await t.loginDevice(agentEmail, "AGENT", team);
    const outsider = await t.loginDevice(outsiderEmail, "AGENT", "elsewhere");
    await t.db.user.create({ data: { email: managerEmail, role: "MANAGER", team } });
    await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });

    const mine = (await post(agent.headers, { phone: randomMobile(), outcome: "INTERESTED" })).json().contact;
    const theirs = (await post(outsider.headers, { phone: randomMobile(), outcome: "INTERESTED" })).json().contact;

    const ids = async (email: string, qs = "") => {
      const res = await t.app.inject({ url: `/api/contacts?limit=100${qs}`, headers: await t.sessionFor(email) });
      expect(res.statusCode).toBe(200);
      return res.json().items.map((c: { id: string }) => c.id) as string[];
    };
    expect(await ids(agentEmail)).toEqual([mine.id]);
    expect(await ids(managerEmail)).toContain(mine.id);
    expect(await ids(managerEmail)).not.toContain(theirs.id);
    const all = await ids(adminEmail, `&ownerId=${outsider.user.id}`);
    expect(all).toEqual([theirs.id]);

    const res = await t.app.inject({ url: `/api/contacts/${theirs.id}`, headers: await t.sessionFor(agentEmail) });
    expect(res.statusCode).toBe(404);

    // Agents cannot reassign; managers can within their team.
    const h = await t.sessionFor(agentEmail);
    expect((await t.app.inject({ method: "PATCH", url: `/api/contacts/${mine.id}`, headers: h, payload: { ownerId: outsider.user.id } })).statusCode).toBe(403);
    const mh = await t.sessionFor(managerEmail);
    expect((await t.app.inject({ method: "PATCH", url: `/api/contacts/${mine.id}`, headers: mh, payload: { ownerId: outsider.user.id } })).statusCode).toBe(403);
    const ok = await t.app.inject({ method: "PATCH", url: `/api/contacts/${mine.id}`, headers: mh, payload: { status: "NOT_INTERESTED", nextFollowUpAt: null, name: "Renamed" } });
    expect(ok.json()).toMatchObject({ status: "NOT_INTERESTED", name: "Renamed" });
  });

  it("filters due today / overdue", async () => {
    const email = uniqueEmail("agent");
    const s = await t.loginDevice(email);
    const { start } = istDay();
    const overdue = (await post(s.headers, { phone: randomMobile(), outcome: "CALL_BACK", followUpAt: iso(new Date(start.getTime() - minutes(60))) })).json().contact;
    const today = (await post(s.headers, { phone: randomMobile(), outcome: "CALL_BACK", followUpAt: iso(new Date(start.getTime() + minutes(60))) })).json().contact;
    const h = await t.sessionFor(email);
    const get = async (due: string) => (await t.app.inject({ url: `/api/contacts?due=${due}`, headers: h })).json().items.map((c: { id: string }) => c.id);
    expect(await get("overdue")).toEqual([overdue.id]);
    expect(await get("today")).toEqual([today.id]);
  });

  it("builds a timeline without listing a linked call twice, and adds notes", async () => {
    const email = uniqueEmail("agent");
    const s = await t.loginDevice(email);
    const phone = randomMobile();
    const at = new Date(Date.now() - minutes(90));
    const linkedCall = await registerCall(s.headers, phone, at);
    const loneCall = await registerCall(s.headers, phone, new Date(at.getTime() - minutes(60)));
    const { contact, activity } = (await post(s.headers, { phone, outcome: "INTERESTED", occurredAt: iso(at) })).json();
    await t.db.transcript.create({ data: { callId: linkedCall, text: "hi", provider: "test", summary: "Wants a quote" } });

    const h = await t.sessionFor(email);
    const note = await t.app.inject({ method: "POST", url: `/api/contacts/${contact.id}/notes`, headers: h, payload: { note: "Sent proposal" } });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ type: "NOTE", note: "Sent proposal" });

    const res = (await t.app.inject({ url: `/api/contacts/${contact.id}`, headers: h })).json();
    expect(res.contact.id).toBe(contact.id);
    const tl = res.timeline as { kind: string; id: string; type?: string; call?: { id: string; summary: string | null; hasAudio: boolean } }[];
    expect(tl.map((i) => i.kind)).toEqual(["activity", "activity", "call"]);
    expect(tl[0]!.type).toBe("NOTE");
    expect(tl[1]).toMatchObject({ id: activity.id, call: { id: linkedCall, summary: "Wants a quote", hasAudio: false } });
    expect(tl[2]).toMatchObject({ kind: "call", id: loneCall, hasAudio: false, summary: null });
    expect(tl.filter((i) => i.id === linkedCall)).toHaveLength(0);
  });

  it("reports per-rep stats for managers only", async () => {
    const team = `team-${randomUUID().slice(0, 6)}`;
    const repEmail = uniqueEmail("agent");
    const mgrEmail = uniqueEmail("mgr");
    const rep = await t.loginDevice(repEmail, "AGENT", team);
    await t.db.user.create({ data: { email: mgrEmail, role: "MANAGER", team } });
    const { start } = istDay();
    await post(rep.headers, { phone: randomMobile(), outcome: "INTERESTED", durationS: 120 });
    await post(rep.headers, { phone: randomMobile(), outcome: "NO_ANSWER", durationS: 0 });
    await post(rep.headers, { phone: randomMobile(), outcome: "CALL_BACK", durationS: 30, followUpAt: iso(new Date(start.getTime() + minutes(1))) });
    await post(rep.headers, { phone: randomMobile(), outcome: "CALL_BACK", followUpAt: iso(new Date(start.getTime() - minutes(1))) });
    await post(rep.headers, { phone: randomMobile(), type: "WHATSAPP" });
    // Outside the range.
    await post(rep.headers, { phone: randomMobile(), outcome: "INTERESTED", durationS: 999, occurredAt: iso(new Date(start.getTime() - 3 * 86400_000)) });

    expect((await t.app.inject({ url: "/api/activity/reps", headers: await t.sessionFor(repEmail) })).statusCode).toBe(403);
    const res = await t.app.inject({ url: "/api/activity/reps", headers: await t.sessionFor(mgrEmail) });
    expect(res.statusCode).toBe(200);
    const row = res.json().items.find((i: { user: { id: string } }) => i.user.id === rep.user.id);
    expect(row).toEqual({
      user: { id: rep.user.id, name: null, email: repEmail },
      callsMade: 4,
      answered: 3,
      talkTimeS: 150,
      whatsapp: 1,
      followUpsDueToday: 1,
      overdue: 1,
    });
  });
});
