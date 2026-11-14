import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CrmSync, NOTE_MAX_CHARS, noteContent, zohoDateTime, zohoDuration } from "../src/crm/sync.js";
import { ZohoClient } from "../src/crm/zoho.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

/** Fake Zoho: routes by "METHOD path" (path without /crm/v8/ and query), records every request. */
function fakeZoho() {
  const f = {
    calls: [] as { method: string; url: string; body: any }[],
    tokenRefreshes: 0,
    contacts: [] as any[],
    leads: [] as any[],
    users: [{ id: "zu-1", email: "rep@usaindiacfo.com" }] as any[],
    nextId: 100,
    /** Queued status overrides: the next request gets this status. */
    failNext: [] as { status: number; retryAfter?: string }[],
    deleted: new Set<string>(),
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body;
      f.calls.push({ method, url, body });
      const fail = f.failNext.shift();
      if (fail) return new Response("{}", { status: fail.status, headers: fail.retryAfter ? { "retry-after": fail.retryAfter } : {} });
      if (url.includes("/oauth/v2/token")) {
        f.tokenRefreshes++;
        return Response.json({ access_token: `tok-${f.tokenRefreshes}`, expires_in: 3600, api_domain: "https://www.zohoapis.in" });
      }
      const path = new URL(url).pathname.replace("/crm/v8/", "");
      if (path === "Contacts/search") return f.contacts.length ? Response.json({ data: f.contacts }) : new Response(null, { status: 204 });
      if (path === "Leads/search") return f.leads.length ? Response.json({ data: f.leads }) : new Response(null, { status: 204 });
      if (path === "users") return Response.json({ users: f.users, info: { more_records: false } });
      const ok = (id: string) => Response.json({ data: [{ code: "SUCCESS", status: "success", message: "ok", details: { id } }] });
      if (method === "POST") return ok(`z${f.nextId++}`);
      if (method === "PUT") {
        const id = path.split("/")[1]!;
        if (f.deleted.has(id)) return Response.json({ data: [{ code: "INVALID_DATA", status: "error", message: "the related id given seems to be invalid", details: {} }] }, { status: 400 });
        return ok(id);
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    writes: (path: string) => f.calls.filter((c) => c.method !== "GET" && new URL(c.url).pathname.endsWith(path)),
  };
  return f;
}

const client = (f: ReturnType<typeof fakeZoho>, now?: () => number) =>
  new ZohoClient({
    clientId: "cid",
    clientSecret: "secret",
    refreshToken: "rt",
    accountsUrl: "https://accounts.zoho.in",
    apiUrl: "https://www.zohoapis.in",
    fetch: f.fetch,
    sleep: async () => {},
    now,
  });

describe("ZohoClient", () => {
  it("caches the access token and refreshes it before expiry", async () => {
    const f = fakeZoho();
    let now = 0;
    const c = client(f, () => now);
    await c.searchByPhone("Leads", "9876543210");
    await c.searchByPhone("Leads", "9876543210");
    expect(f.tokenRefreshes).toBe(1);
    expect(f.calls[0]!.body).toContain("grant_type=refresh_token");
    now = 56 * 60_000; // inside the 5-minute margin
    await c.searchByPhone("Leads", "9876543210");
    expect(f.tokenRefreshes).toBe(2);
    const auth = (f.calls.at(-1) as any).url;
    expect(auth).toContain("/crm/v8/Leads/search?phone=9876543210");
  });

  it("treats 204 from search as not found", async () => {
    const f = fakeZoho();
    expect(await client(f).searchByPhone("Contacts", "9876543210")).toEqual([]);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const f = fakeZoho();
    const c = client(f);
    await c.accessToken();
    f.failNext.push({ status: 429, retryAfter: "2" }, { status: 503 });
    f.contacts = [{ id: "c1" }];
    expect(await c.searchByPhone("Contacts", "9876543210")).toHaveLength(1);
    expect(f.calls.filter((x) => x.url.includes("Contacts/search"))).toHaveLength(3);
  });

  it("gives up after 4 tries", async () => {
    const f = fakeZoho();
    const c = client(f);
    await c.accessToken();
    f.failNext.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await expect(c.searchByPhone("Contacts", "1")).rejects.toThrow(/500/);
  });

  it("re-refreshes once on 401", async () => {
    const f = fakeZoho();
    const c = client(f);
    await c.accessToken();
    f.failNext.push({ status: 401 });
    await c.searchByPhone("Leads", "9876543210");
    expect(f.tokenRefreshes).toBe(2);
  });
});

describe("formatting", () => {
  it("formats IST start time and mm:ss duration", () => {
    expect(zohoDateTime(new Date("2026-11-14T04:35:00Z"))).toBe("2026-11-14T10:05:00+05:30");
    expect(zohoDuration(125, false)).toBe("02:05");
    expect(zohoDuration(0, false)).toBe("00:01");
    expect(zohoDuration(null, true)).toBe("00:00");
  });
  it("truncates long notes", () => {
    const n = noteContent({ summary: "s", actionItems: ["a"], text: "x".repeat(50_000), textEn: null }, "http://l");
    expect(n.length).toBe(NOTE_MAX_CHARS);
    expect(n).toMatch(/^Summary:\ns\n\nAction items:\n- a\n\nRecording: http:\/\/l/);
  });
});

describe("CrmSync", () => {
  let t: Awaited<ReturnType<typeof setupTestApp>>;
  let userId: string;
  let f: ReturnType<typeof fakeZoho>;
  let sync: CrmSync;
  const repEmail = uniqueEmail("rep");

  beforeAll(async () => {
    t = await setupTestApp();
    userId = (await t.db.user.create({ data: { email: repEmail, name: "Rep One" } })).id;
  });
  afterAll(async () => {
    await t.app.close();
    await t.db.$disconnect();
  });
  beforeEach(() => {
    f = fakeZoho();
    f.users = [{ id: "zu-rep", email: repEmail.toUpperCase() }];
    sync = new CrmSync(t.db, client(f), { publicUrl: "https://rec.example.com", summarizeEnabled: false, createUnknownLeads: false });
  });

  async function newCall(opts: { phone?: string; summary?: string } = {}) {
    const call = await t.db.call.create({
      data: {
        id: randomUUID(),
        userId,
        phoneE164: opts.phone ?? "+919876543210",
        direction: "OUTGOING",
        startedAt: new Date(),
        durationS: 95,
        originalSha256: sha256(randomBytes(8)),
        status: "TRANSCRIBED",
      },
    });
    await t.db.transcript.create({ data: { callId: call.id, text: "namaste", textEn: "hello", provider: "test", summary: opts.summary ?? null } });
    return call;
  }

  it("prefers a Contact over a Lead, newest first, and maps the owner by email", async () => {
    f.leads = [{ id: "lead1" }];
    f.contacts = [
      { id: "old", Modified_Time: "2025-01-01T00:00:00+05:30" },
      { id: "new", Modified_Time: "2026-01-01T00:00:00+05:30" },
    ];
    const call = await newCall({ summary: "Asked for a quote" });
    expect(await sync.syncCall(call.id)).toBe("SYNCED");
    const [callPost] = f.writes("/Calls");
    const rec = callPost!.body.data[0];
    expect(rec).toMatchObject({ Who_Id: { id: "new" }, Call_Type: "Outbound", Call_Duration: "01:35", Owner: { id: "zu-rep" } });
    expect(rec.Description).toContain(`https://rec.example.com/calls/${call.id}`);
    expect(rec.Description).toContain("Asked for a quote");
    expect(f.calls.some((c) => c.url.includes("Contacts/search?phone=9876543210"))).toBe(true);
    const [notePost] = f.writes("/Notes");
    expect(notePost!.body.data[0].Parent_Id).toEqual({ module: { api_name: "Contacts" }, id: "new" });
    expect(notePost!.body.data[0].Note_Content).toContain("hello");
    const row = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(row).toMatchObject({ crmStatus: "SYNCED", crmRecordModule: "Contacts", crmRecordId: "new", crmAttempts: 0 });
    expect(row.crmCallId).toBeTruthy();
    expect(row.crmNoteId).toBeTruthy();
  });

  it("links Leads through What_Id + $se_module and falls back to the default owner", async () => {
    f.users = [];
    f.leads = [{ id: "lead9" }];
    const call = await newCall();
    await sync.syncCall(call.id);
    const rec = f.writes("/Calls")[0]!.body.data[0];
    expect(rec).toMatchObject({ What_Id: { id: "lead9" }, $se_module: "Leads" });
    expect(rec.Owner).toBeUndefined();
  });

  it("updates instead of duplicating on resync", async () => {
    f.contacts = [{ id: "c1" }];
    const call = await newCall();
    await sync.syncCall(call.id);
    const first = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    await t.db.transcript.update({ where: { callId: call.id }, data: { textEn: "hello again" } });
    expect(await sync.resync(call.id)).toBe("SYNCED");
    expect(f.calls.filter((c) => c.method === "POST" && !c.url.includes("oauth"))).toHaveLength(2); // one Call + one Note, ever
    const puts = f.calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => new URL(p.url).pathname)).toEqual([`/crm/v8/Calls/${first.crmCallId}`, `/crm/v8/Notes/${first.crmNoteId}`]);
    expect(puts[1]!.body.data[0].Note_Content).toContain("hello again");
    expect(puts[1]!.body.data[0].Parent_Id).toBeUndefined();
    // The same record is reused without searching again.
    expect(f.calls.filter((c) => c.url.includes("/search")).length).toBe(1);
  });

  it("recreates a Call deleted in Zoho", async () => {
    f.contacts = [{ id: "c1" }];
    const call = await newCall();
    await sync.syncCall(call.id);
    const first = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    f.deleted.add(first.crmCallId!);
    await sync.resync(call.id);
    const after = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(after.crmCallId).not.toBe(first.crmCallId);
  });

  it("marks unmatched numbers NO_MATCH, or creates a Lead when enabled", async () => {
    const call = await newCall({ phone: "+919811111111" });
    expect(await sync.syncCall(call.id)).toBe("NO_MATCH");
    expect(f.calls.filter((c) => c.method !== "GET" && !c.url.includes("oauth"))).toHaveLength(0);

    const creating = new CrmSync(t.db, client(f), { publicUrl: "https://x", summarizeEnabled: false, createUnknownLeads: true });
    expect(await creating.resync(call.id)).toBe("SYNCED");
    const lead = f.writes("/Leads")[0]!.body.data[0];
    expect(lead).toMatchObject({ Phone: "+919811111111", Lead_Source: "UIC Dialer" });
    expect((await t.db.call.findUniqueOrThrow({ where: { id: call.id } })).crmRecordModule).toBe("Leads");
  });

  it("stores errors with backoff and retries later", async () => {
    f.contacts = [{ id: "c1" }];
    const call = await newCall();
    await client(f).accessToken();
    sync = new CrmSync(t.db, client(f), { publicUrl: "https://x", summarizeEnabled: false, createUnknownLeads: false });
    f.failNext.push({ status: 400 }); // token refresh fails (non-retryable)
    expect(await sync.syncCall(call.id)).toBe("ERROR");
    const row = await t.db.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(row.crmStatus).toBe("ERROR");
    expect(row.crmAttempts).toBe(1);
    expect(row.crmNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await sync.candidates(1000)).not.toContain(call.id);
    await t.db.call.update({ where: { id: call.id }, data: { crmNextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await sync.candidates(1000)).toContain(call.id);
    expect(await sync.syncCall(call.id)).toBe("SYNCED");
  });

  it("waits for open translate/summary jobs and for the summary when summaries are on", async () => {
    const call = await newCall();
    const job = await t.db.job.create({ data: { callId: call.id, kind: "translate", status: "QUEUED" } });
    expect(await sync.candidates(1000)).not.toContain(call.id);
    await t.db.job.update({ where: { id: job.id }, data: { status: "DONE" } });
    expect(await sync.candidates(1000)).toContain(call.id);

    const waiting = new CrmSync(t.db, client(f), { publicUrl: "https://x", summarizeEnabled: true, createUnknownLeads: false });
    expect(await waiting.candidates(1000)).not.toContain(call.id);
    await t.db.transcript.update({ where: { callId: call.id }, data: { summary: "done" } });
    expect(await waiting.candidates(1000)).toContain(call.id);
  });

  it("re-syncs when the transcript changes after a sync", async () => {
    f.contacts = [{ id: "c1" }];
    const call = await newCall();
    await sync.syncCall(call.id);
    expect(await sync.candidates(1000)).not.toContain(call.id);
    await new Promise((r) => setTimeout(r, 5));
    await t.db.transcript.update({ where: { callId: call.id }, data: { textEn: "re-transcribed" } });
    expect(await sync.candidates(1000)).toContain(call.id);
  });

  it("admin routes: stats, resync and backfill (audited)", async () => {
    const admin = uniqueEmail("crmadmin");
    await t.db.user.create({ data: { email: admin, role: "ADMIN" } });
    const s = await t.sessionFor(admin);
    // The test app has no Zoho configured.
    const stats = await t.app.inject({ method: "GET", url: "/api/crm", headers: s });
    expect(stats.json()).toMatchObject({ enabled: false });
    const call = await newCall();
    const res = await t.app.inject({ method: "POST", url: `/api/admin/crm/resync/${call.id}`, headers: s, payload: {} });
    expect(res.statusCode).toBe(409);
    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: s });
    expect(detail.json().crm).toMatchObject({ enabled: false, status: null });
    expect(detail.json().crmCallId).toBeUndefined();
  });

  it("backfill queues unsynced calls from the last 30 days", async () => {
    const call = await newCall();
    await t.db.transcript.update({ where: { callId: call.id }, data: { updatedAt: new Date(Date.now() - 10 * 86400_000) } });
    await t.db.call.update({ where: { id: call.id }, data: { startedAt: new Date(Date.now() - 10 * 86400_000) } });
    expect(await sync.candidates(1000)).not.toContain(call.id);
    expect(await sync.queueBackfill()).toBeGreaterThan(0);
    expect(await sync.candidates(1000)).toContain(call.id);
  });
});
