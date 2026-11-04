import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp({ ALLOWED_DOMAIN: "usaindiacfo.com", ADMIN_EMAILS: "boss@gmail.com" });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const login = async (idToken: string) =>
  t.app.inject({
    method: "POST",
    url: "/v1/auth/google",
    payload: { idToken, device: { installId: randomUUID() } },
  });

describe("app sign-in with Google", () => {
  it("auto-provisions a Workspace-domain user as agent", async () => {
    const email = uniqueEmail();
    const res = await login(await t.googleToken({ email, hd: "usaindiacfo.com" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email, role: "AGENT" });
    expect(res.json().refreshToken).toBeTruthy();
  });

  it("bootstraps ADMIN_EMAILS as admin", async () => {
    const res = await login(await t.googleToken({ email: "boss@gmail.com" }));
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("ADMIN");
  });

  it("rejects unknown accounts outside the domain", async () => {
    const res = await login(await t.googleToken({ email: "stranger@gmail.com" }));
    expect(res.statusCode).toBe(403);
  });

  it("rejects wrong audience", async () => {
    const res = await login(await t.googleToken({ email: uniqueEmail(), hd: "usaindiacfo.com" }, { aud: "other-app" }));
    expect(res.statusCode).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const res = await login(await t.googleToken({ email: uniqueEmail(), hd: "usaindiacfo.com" }, { exp: "-10m" }));
    expect(res.statusCode).toBe(401);
  });

  it("rejects unverified emails", async () => {
    const res = await login(await t.googleToken({ email: uniqueEmail(), hd: "usaindiacfo.com", email_verified: false }));
    expect(res.statusCode).toBe(403);
  });

  it("rejects deactivated users", async () => {
    const email = uniqueEmail();
    await t.db.user.create({ data: { email, active: false } });
    const res = await login(await t.googleToken({ email }));
    expect(res.statusCode).toBe(403);
  });

  it("rejects a different Google account claiming a linked email", async () => {
    const email = uniqueEmail();
    expect((await login(await t.googleToken({ email, hd: "usaindiacfo.com", sub: "a1" }))).statusCode).toBe(200);
    expect((await login(await t.googleToken({ email, hd: "usaindiacfo.com", sub: "b2" }))).statusCode).toBe(403);
  });
});

describe("refresh tokens", () => {
  it("rotates, and reuse of an old token revokes the device", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const r1 = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const next = r1.json();

    // Replaying the first token = theft signal.
    const replay = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(replay.statusCode).toBe(401);

    // ...which kills the newer token and the access token too.
    const r2 = await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: next.refreshToken } });
    expect(r2.statusCode).toBe(401);
    const cfg = await t.app.inject({ method: "GET", url: "/v1/device/config", headers: { authorization: `Bearer ${next.accessToken}` } });
    expect(cfg.statusCode).toBe(401);
  });

  it("deactivating a user blocks the app immediately", async () => {
    const email = uniqueEmail();
    const s = await t.loginDevice(email);
    expect((await t.app.inject({ method: "GET", url: "/v1/device/config", headers: s.headers })).statusCode).toBe(200);
    await t.db.user.update({ where: { email }, data: { active: false } });
    expect((await t.app.inject({ method: "GET", url: "/v1/device/config", headers: s.headers })).statusCode).toBe(401);
  });
});

describe("dashboard session", () => {
  it("requires a session and enforces roles and origin", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);

    const agent = uniqueEmail("agent");
    await t.db.user.create({ data: { email: agent } });
    const s = await t.sessionFor(agent);
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: s.cookie } });
    expect(me.json().email).toBe(agent);
    expect((await t.app.inject({ method: "GET", url: "/api/users", headers: { cookie: s.cookie } })).statusCode).toBe(403);

    const admin = uniqueEmail("admin");
    await t.db.user.create({ data: { email: admin, role: "ADMIN" } });
    const a = await t.sessionFor(admin);
    const payload = { email: uniqueEmail("new"), role: "AGENT" };
    const noOrigin = await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: a.cookie }, payload });
    expect(noOrigin.statusCode).toBe(403);
    const ok = await t.app.inject({ method: "POST", url: "/api/users", headers: { cookie: a.cookie, origin: a.origin }, payload });
    expect(ok.statusCode).toBe(201);
  });
});

describe("app uses the dashboard API with its token", () => {
  it("scopes by role and needs no origin header", async () => {
    const agent = await t.loginDevice(uniqueEmail());
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: agent.headers });
    expect(me.statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/calls", headers: agent.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/users", headers: agent.headers })).statusCode).toBe(403);
    const admin = await t.loginDevice(uniqueEmail(), "ADMIN");
    expect((await t.app.inject({ method: "GET", url: "/api/users", headers: admin.headers })).statusCode).toBe(200);
    const bad = { authorization: "Bearer nope" };
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: bad })).statusCode).toBe(401);
  });
});
