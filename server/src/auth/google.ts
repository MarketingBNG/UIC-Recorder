import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  hd?: string;
  name?: string;
  picture?: string;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

/**
 * Verifies a Google ID token's signature, issuer, audience and expiry.
 * `keys` is injectable so tests can sign tokens with a local key.
 */
export function createGoogleVerifier(
  audience: string,
  keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL),
): GoogleVerifier {
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: GOOGLE_ISSUERS,
      audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== "string" || typeof payload["email"] !== "string") {
      throw new Error("ID token missing sub/email");
    }
    return claimsToIdentity(payload);
  };
}

export function claimsToIdentity(c: Record<string, unknown>): GoogleIdentity {
  return {
    sub: String(c["sub"]),
    email: String(c["email"]).toLowerCase(),
    emailVerified: c["email_verified"] === true || c["email_verified"] === "true",
    hd: typeof c["hd"] === "string" ? c["hd"].toLowerCase() : undefined,
    name: typeof c["name"] === "string" ? c["name"] : undefined,
    picture: typeof c["picture"] === "string" ? c["picture"] : undefined,
  };
}
