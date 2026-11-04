import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a public audio link handed to Fireflies stays valid. */
export const AUDIO_URL_TTL_S = 3 * 3600;

// A key derived from the server secret, so the raw JWT secret is never used for two purposes.
const keyFor = (secret: string) => createHmac("sha256", secret).update("uic:public-audio-url:v1").digest();

function sign(secret: string, callId: string, exp: number): string {
  return createHmac("sha256", keyFor(secret)).update(`${callId}.${exp}`).digest("base64url");
}

/** Path + query for a public, expiring link to one call's audio. */
export function signAudioPath(secret: string, callId: string, ext: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + AUDIO_URL_TTL_S;
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
  return { path: `/public/audio/${callId}${safeExt}?exp=${exp}&sig=${sign(secret, callId, exp)}`, expiresAt: new Date(exp * 1000) };
}

/** Constant-time check of a signature for this exact call id and expiry. */
export function verifyAudioSignature(secret: string, callId: string, exp: string | undefined, sig: string | undefined, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expN = Number(exp);
  if (expN * 1000 <= now) return false;
  const expected = Buffer.from(sign(secret, callId, expN));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
