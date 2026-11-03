import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";
import type { Db } from "../db.js";

export const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 90 * 24 * 3600 * 1000;
const ISSUER = "uic-recorder";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const keyFrom = (secret: string) => createHash("sha256").update(secret).digest();

export interface AccessClaims {
  userId: string;
  deviceId: string;
}

export class TokenService {
  private readonly jwtKey: Uint8Array;
  private readonly sessionKey: Uint8Array;

  constructor(
    private readonly db: Db,
    jwtSecret: string,
    sessionSecret: string,
  ) {
    this.jwtKey = keyFrom(jwtSecret);
    this.sessionKey = keyFrom(sessionSecret);
  }

  // ---- App tokens -------------------------------------------------------

  async issueForDevice(userId: string, deviceId: string) {
    const accessToken = await new SignJWT({ did: deviceId, typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(this.jwtKey);
    const refreshToken = randomBytes(32).toString("base64url");
    const row = await this.db.refreshToken.create({
      data: { deviceId, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_S, refreshTokenId: row.id };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.jwtKey, { issuer: ISSUER, algorithms: ["HS256"] });
    if (payload["typ"] !== "access" || typeof payload.sub !== "string" || typeof payload["did"] !== "string") {
      throw new Error("Not an access token");
    }
    return { userId: payload.sub, deviceId: payload["did"] };
  }

  /**
   * Rotates a refresh token. Reusing an already-rotated token is treated as theft:
   * the device is revoked and all its tokens are invalidated.
   */
  async rotate(refreshToken: string) {
    const row = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { device: { include: { user: true } } },
    });
    if (!row) return null;
    if (row.revokedAt) {
      await this.revokeDevice(row.deviceId);
      return null;
    }
    const { device } = row;
    if (row.expiresAt < new Date() || device.revokedAt || !device.user.active) return null;

    const next = await this.issueForDevice(device.userId, device.id);
    // Only succeeds if nobody rotated this token concurrently.
    const { count } = await this.db.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: next.refreshTokenId },
    });
    if (count === 0) {
      await this.revokeDevice(row.deviceId);
      return null;
    }
    return { ...next, user: device.user };
  }

  async revokeRefresh(refreshToken: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const now = new Date();
    await this.db.$transaction([
      this.db.device.update({ where: { id: deviceId }, data: { revokedAt: now } }),
      this.db.refreshToken.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  // ---- Dashboard session / OIDC state (encrypted cookies) ---------------

  async seal(payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
    return new EncryptJWT(payload)
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .encrypt(this.sessionKey);
  }

  async unseal(token: string): Promise<Record<string, unknown>> {
    const { payload } = await jwtDecrypt(token, this.sessionKey, { issuer: ISSUER });
    return payload;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return timingSafeEqual(ab, bb);
}
