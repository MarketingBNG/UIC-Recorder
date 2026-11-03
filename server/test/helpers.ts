import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { buildApp } from "../src/app.js";
import { createGoogleVerifier } from "../src/auth/google.js";
import { SESSION_COOKIE, SESSION_TTL_S } from "../src/auth/guards.js";
import { TokenService } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { LocalStorage } from "../src/storage/local.js";

export const WEB_CLIENT_ID = "test-web-client.apps.googleusercontent.com";
export const WORKER_TOKEN = "w".repeat(40);
export const PUBLIC_URL = "http://localhost:8000";

export async function setupTestApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env["TEST_DATABASE_URL"]!,
    STORAGE_DIR: mkdtempSync(path.join(os.tmpdir(), "uic-store-")),
    GOOGLE_WEB_CLIENT_ID: WEB_CLIENT_ID,
    JWT_SECRET: "j".repeat(40),
    SESSION_SECRET: "s".repeat(40),
    WORKER_TOKEN,
    PUBLIC_URL,
    MAX_UPLOAD_MB: "1",
    ...env,
  });
  const db = createDb(config.DATABASE_URL);
  const storage = new LocalStorage(config.STORAGE_DIR);
  await storage.init();

  // Local signing key stands in for Google's.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
  const tokens = new TokenService(db, config.JWT_SECRET, config.SESSION_SECRET);
  const app = await buildApp({
    config,
    db,
    storage,
    tokens,
    verifyGoogle: createGoogleVerifier(WEB_CLIENT_ID, createLocalJWKSet({ keys: [jwk] })),
  });

  const googleToken = (claims: Record<string, unknown> = {}, opts: { aud?: string; exp?: string } = {}) =>
    new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience(opts.aud ?? WEB_CLIENT_ID)
      .setSubject(String(claims["sub"] ?? `sub-${claims["email"]}`))
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);

  /** Creates a user and signs in as a phone; returns bearer headers. */
  const loginDevice = async (email: string, role: "ADMIN" | "MANAGER" | "AGENT" = "AGENT", team?: string) => {
    await db.user.upsert({ where: { email }, create: { email, role, team: team ?? null }, update: {} });
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/google",
      payload: { idToken: await googleToken({ email }), device: { installId: randomUUID(), model: "Test" } },
    });
    if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
    const body = res.json();
    return { headers: { authorization: `Bearer ${body.accessToken}` }, ...body };
  };

  /** Dashboard session cookie for an existing user. */
  const sessionFor = async (email: string) => {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const sealed = await tokens.seal({ uid: user.id }, SESSION_TTL_S);
    return { cookie: `${SESSION_COOKIE}=${sealed}`, origin: PUBLIC_URL };
  };

  const workerHeaders = { authorization: `Bearer ${WORKER_TOKEN}` };

  return { app, db, config, storage, tokens, googleToken, loginDevice, sessionFor, workerHeaders };
}

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const uniqueEmail = (p = "user") => `${p}-${randomUUID().slice(0, 8)}@usaindiacfo.com`;
