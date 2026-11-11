import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

const TOKEN = "p".repeat(40);
let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp({ APP_PUBLISH_TOKEN: TOKEN });
  await t.db.$executeRaw`UPDATE settings SET latest_app = NULL`;
});
afterAll(async () => {
  await t.db.$executeRaw`UPDATE settings SET latest_app = NULL`;
  await t.app.close();
  await t.db.$disconnect();
});

const publish = (apk: Buffer, versionCode: number, opts: { token?: string; sha?: string } = {}) =>
  t.app.inject({
    method: "POST",
    url: "/internal/app/publish",
    headers: {
      authorization: `Bearer ${opts.token ?? TOKEN}`,
      "content-type": "application/vnd.android.package-archive",
      "x-version-code": String(versionCode),
      "x-version-name": `0.3.${versionCode}`,
      "x-content-sha256": opts.sha ?? sha256(apk),
    },
    payload: apk,
  });

describe("POST /internal/app/publish", () => {
  it("publishes a newer APK that phones then see and download", async () => {
    const apk = randomBytes(5000);
    const res = await publish(apk, 101);
    expect(res.statusCode).toBe(201);

    const phone = await t.loginDevice(uniqueEmail());
    const latest = await t.app.inject({ url: "/v1/app/latest", headers: phone.headers });
    expect(latest.json()).toMatchObject({ available: true, versionCode: 101, versionName: "0.3.101", sha256: sha256(apk) });
    const dl = await t.app.inject({ url: "/v1/app/download", headers: phone.headers });
    expect(dl.statusCode).toBe(200);
    expect(sha256(dl.rawPayload)).toBe(sha256(apk));
  });

  it("is idempotent for the same build, refuses older or equal versions, and keeps only two APKs", async () => {
    const apk = randomBytes(3000);
    expect((await publish(apk, 102)).statusCode).toBe(201);
    expect((await publish(apk, 102)).json()).toMatchObject({ published: false }); // CI re-run
    expect((await publish(randomBytes(10), 102)).statusCode).toBe(409);
    expect((await publish(randomBytes(10), 50)).statusCode).toBe(409);
    expect((await publish(randomBytes(3000), 103)).statusCode).toBe(201);
    const dir = path.join(t.config.STORAGE_DIR, "apk");
    expect(existsSync(path.join(dir, "uic-recorder-101.apk"))).toBe(false);
    expect(existsSync(path.join(dir, "uic-recorder-102.apk"))).toBe(true);
    expect(existsSync(path.join(dir, "uic-recorder-103.apk"))).toBe(true);
  });

  it("rejects a bad token and a checksum mismatch", async () => {
    expect((await publish(randomBytes(10), 200, { token: "x".repeat(40) })).statusCode).toBe(401);
    const bad = await publish(randomBytes(100), 201, { sha: sha256(Buffer.from("other")) });
    expect(bad.statusCode).toBe(422);
    const phone = await t.loginDevice(uniqueEmail());
    expect((await t.app.inject({ url: "/v1/app/latest", headers: phone.headers })).json().versionCode).toBe(103);
  });
});
