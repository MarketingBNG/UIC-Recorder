import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** Normalises a dialled number to E.164, or undefined if it can't be parsed. */
export function toE164(raw: string | null | undefined, defaultRegion: string): string | undefined {
  if (!raw) return undefined;
  const parsed = parsePhoneNumberFromString(raw, defaultRegion as CountryCode);
  return parsed?.isPossible() ? parsed.number : undefined;
}
