/**
 * Best-effort metadata from call-recorder file names, e.g.
 *   Samsung:  "Call recording Ravi Kumar_231015_143022.m4a"
 *   MIUI:     "Ravi Kumar(9876543210)_20231015143022.mp3"
 *   Generic:  "+919876543210_2023-10-15_14-30-22.amr"
 * Dates in names are local phone time; `tzOffsetMinutes` converts them to UTC.
 */
export interface ParsedName {
  phone?: string;
  contactName?: string;
  startedAt?: Date;
  direction?: "INCOMING" | "OUTGOING";
}

const DATE_PATTERNS: { re: RegExp; shortYear: boolean }[] = [
  // 2023-10-15 14-30-22, 20231015_143022, 20231015143022, 2023.10.15 14:30:22
  { re: /(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _\-T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?!\d)/, shortYear: false },
  // 231015_143022 (Samsung)
  { re: /(?<!\d)(\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?!\d)/, shortYear: true },
];

export function parseRecordingName(fileName: string, tzOffsetMinutes: number): ParsedName {
  const out: ParsedName = {};
  let rest = fileName.replace(/\.[a-z0-9]{2,5}$/i, "");

  for (const { re, shortYear } of DATE_PATTERNS) {
    const m = re.exec(rest);
    if (!m) continue;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
    const year = shortYear ? 2000 + y : y;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) continue;
    out.startedAt = new Date(Date.UTC(year, mo - 1, d, h, mi, s) - tzOffsetMinutes * 60_000);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    break;
  }

  const phone = /(?<![\d])(\+?\d[\d\s-]{6,16}\d)(?![\d])/.exec(rest);
  if (phone) {
    const digits = phone[1]!.replace(/[^\d+]/g, "");
    const count = digits.replace("+", "").length;
    if (count >= 7 && count <= 15) {
      out.phone = digits;
      rest = rest.slice(0, phone.index) + " " + rest.slice(phone.index + phone[0].length);
    }
  }

  // Letter-only boundaries: "_" counts as a word character for \b.
  if (/(?<![a-z])(incoming|in_call)(?![a-z])/i.test(fileName)) out.direction = "INCOMING";
  else if (/(?<![a-z])(outgoing|out_call)(?![a-z])/i.test(fileName)) out.direction = "OUTGOING";

  const name = rest
    .replace(/call\s*recording|call_rec|recording|record|incoming|outgoing|\bcall\b/gi, " ")
    .replace(/[()[\]_\-.@#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name && /[a-z]/i.test(name) && name.length <= 100) out.contactName = name;
  return out;
}

export const AUDIO_EXT_MIME: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".amr": "audio/amr",
  ".3gp": "audio/3gpp",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};
