import type { FastifyRequest } from "fastify";
import { HttpError, type Deps } from "../context.js";
import type { Prisma, Role, User } from "../generated/prisma/client.js";
import { safeEqual } from "./tokens.js";

export const SESSION_COOKIE = "uic_session";
export const SESSION_TTL_S = 12 * 3600;

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** App requests: access JWT + device not revoked + user active (checked every call). */
export function requireDevice(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, "Missing token");
    let claims;
    try {
      claims = await deps.tokens.verifyAccess(token);
    } catch {
      throw new HttpError(401, "Invalid or expired token");
    }
    const device = await deps.db.device.findUnique({ where: { id: claims.deviceId }, include: { user: true } });
    if (!device || device.userId !== claims.userId || device.revokedAt || !device.user.active) {
      throw new HttpError(401, "Device revoked or user inactive");
    }
    const { user, ...rest } = device;
    req.user = user;
    req.device = rest;
  };
}

/**
 * Dashboard requests: encrypted session cookie + user still active.
 * The Android app uses the same endpoints with its access token (no cookie, so no CSRF check).
 */
export function requireSession(deps: Deps, roles?: Role[]) {
  const device = requireDevice(deps);
  return async (req: FastifyRequest) => {
    if (bearer(req)) {
      await device(req);
      if (roles && !roles.includes(req.user!.role)) throw new HttpError(403, "Forbidden");
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) throw new HttpError(401, "Not signed in");
    let uid: unknown;
    try {
      ({ uid } = await deps.tokens.unseal(cookie));
    } catch {
      throw new HttpError(401, "Session expired");
    }
    const user = typeof uid === "string" ? await deps.db.user.findUnique({ where: { id: uid } }) : null;
    if (!user?.active) throw new HttpError(401, "Not signed in");
    if (roles && !roles.includes(user.role)) throw new HttpError(403, "Forbidden");
    // CSRF: state-changing requests must come from our own origin.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin !== new URL(deps.config.PUBLIC_URL).origin) throw new HttpError(403, "Bad origin");
    }
    req.user = user;
  };
}

export function requireWorker(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, deps.config.WORKER_TOKEN)) throw new HttpError(401, "Bad worker token");
  };
}

/** Which calls a dashboard user may see. */
export function callScope(user: User): Prisma.CallWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.role === "MANAGER" && user.team) return { user: { team: user.team } };
  return { userId: user.id };
}
