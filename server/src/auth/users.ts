import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { User } from "../generated/prisma/client.js";
import type { GoogleIdentity } from "./google.js";

export class AccessDeniedError extends Error {}

/**
 * Maps a verified Google identity to an active user. Same rules for app and dashboard:
 * - email must be verified
 * - existing (admin-added) users must be active and keep the same Google account
 * - unknown users are created only if listed in ADMIN_EMAILS (as admin) or,
 *   when ALLOWED_DOMAIN is set, if their Workspace domain matches (as agent)
 */
export async function resolveUser(db: Db, config: Config, id: GoogleIdentity): Promise<User> {
  if (!id.emailVerified) throw new AccessDeniedError("Google email is not verified");

  const existing = await db.user.findUnique({ where: { email: id.email } });
  if (existing) {
    if (!existing.active) throw new AccessDeniedError("User is deactivated");
    if (existing.googleSub && existing.googleSub !== id.sub) {
      throw new AccessDeniedError("Email is linked to a different Google account");
    }
    return db.user.update({
      where: { id: existing.id },
      data: {
        googleSub: id.sub,
        name: existing.name ?? id.name ?? null,
        pictureUrl: id.picture ?? existing.pictureUrl,
        lastLoginAt: new Date(),
      },
    });
  }

  const isBootstrapAdmin = config.ADMIN_EMAILS.includes(id.email);
  const isDomainUser = !!config.ALLOWED_DOMAIN && id.hd === config.ALLOWED_DOMAIN;
  if (!isBootstrapAdmin && !isDomainUser) {
    throw new AccessDeniedError("This Google account is not allowed. Ask an admin to add you.");
  }
  return db.user.create({
    data: {
      email: id.email,
      googleSub: id.sub,
      name: id.name ?? null,
      pictureUrl: id.picture ?? null,
      role: isBootstrapAdmin ? "ADMIN" : "AGENT",
      lastLoginAt: new Date(),
    },
  });
}
