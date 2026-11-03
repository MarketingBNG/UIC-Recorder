// Bulk-imports call recordings that were already copied off phones.
// Runs on whichever computer holds the folders and uploads to the API in parallel.
// Safe to stop and re-run: files already on the server are skipped by hash.
//
// One person:   npx tsx scripts/import-existing.ts --email ravi@usaindiacfo.com --dir "D:\Recordings\Ravi"
// Many people:  npx tsx scripts/import-existing.ts --root "D:\Recordings" --domain usaindiacfo.com
//               (each sub-folder is named after the person: "ravi" or "ravi@usaindiacfo.com")
//
// Env: API_URL (default http://localhost:8000), IMPORT_TOKEN (must match the server's).
// Options: --concurrency 6  --tz-offset 330 (minutes, IST)  --dry-run
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { AUDIO_EXT_MIME, parseRecordingName } from "../src/calls/filename.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    dir: { type: "string" },
    root: { type: "string" },
    domain: { type: "string" },
    concurrency: { type: "string", default: "6" },
    "tz-offset": { type: "string", default: "330" },
    "dry-run": { type: "boolean", default: false },
  },
});

const API = (process.env["API_URL"] ?? "http://localhost:8000").replace(/\/$/, "");
const TOKEN = process.env["IMPORT_TOKEN"] ?? "";
const CONCURRENCY = Math.max(1, Math.min(32, Number(args.concurrency)));
const TZ = Number(args["tz-offset"]);
const DRY = args["dry-run"];
const FAIL_LOG = path.resolve(`import-failures-${new Date().toISOString().slice(0, 10)}.log`);

if (!TOKEN && !DRY) throw new Error("Set IMPORT_TOKEN (same value as on the server)");

// ---- Which folders belong to which person ------------------------------------

const targets: { email: string; dir: string }[] = [];
if (args.email && args.dir) targets.push({ email: args.email.toLowerCase(), dir: args.dir });
else if (args.root) {
  for (const entry of await readdir(args.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const email = entry.name.includes("@") ? entry.name : args.domain ? `${entry.name}@${args.domain}` : "";
    if (!email) throw new Error(`Folder "${entry.name}" is not an email; pass --domain`);
    targets.push({ email: email.toLowerCase(), dir: path.join(args.root, entry.name) });
  }
} else {
  throw new Error("Use --email + --dir, or --root (+ --domain)");
}

// ---- Helpers --------------------------------------------------------------------

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (AUDIO_EXT_MIME[path.extname(e.name).toLowerCase()]) yield p;
  }
}

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

async function api(method: string, url: string, body?: unknown, retries = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}${url}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function upload(callId: string, file: string, mime: string, hash: string, size: number, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/internal/import/calls/${callId}/audio`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": mime,
          "content-length": String(size),
          "x-content-sha256": hash,
        },
        body: Readable.toWeb(createReadStream(file)) as ReadableStream,
        duplex: "half",
      } as RequestInit);
      if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** Runs `fn` over items with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---- Import ---------------------------------------------------------------------

const totals = { files: 0, skipped: 0, imported: 0, failed: 0 };
const started = Date.now();

for (const { email, dir } of targets) {
  const files: string[] = [];
  for await (const f of walk(dir)) files.push(f);
  console.log(`\n${email}: ${files.length} audio files in ${dir}`);
  totals.files += files.length;

  // Hash in parallel (disk-bound), then ask the server which ones it already has.
  const hashed: { file: string; hash: string; size: number }[] = [];
  await pool(files, CONCURRENCY, async (file) => {
    hashed.push({ file, hash: await sha256File(file), size: (await stat(file)).size });
  });
  const known = new Set<string>();
  if (!DRY) {
    for (let i = 0; i < hashed.length; i += 500) {
      const res = await api("POST", "/internal/import/check", { email, hashes: hashed.slice(i, i + 500).map((h) => h.hash) });
      if (!res.ok) throw new Error(`check failed for ${email}: ${res.status} ${await res.text()}`);
      for (const h of ((await res.json()) as { known: string[] }).known) known.add(h);
    }
  }
  const todo = hashed.filter((h) => !known.has(h.hash));
  totals.skipped += hashed.length - todo.length;
  console.log(`  ${hashed.length - todo.length} already on server, ${todo.length} to upload`);

  let done = 0;
  await pool(todo, CONCURRENCY, async ({ file, hash, size }) => {
    const name = path.basename(file);
    try {
      const meta = parseRecordingName(name, TZ);
      const startedAt = meta.startedAt ?? (await stat(file)).mtime;
      const body = {
        email,
        originalSha256: hash,
        originalName: name.slice(0, 255),
        startedAt: startedAt.toISOString(),
        phoneNumber: meta.phone,
        contactName: meta.contactName,
        direction: meta.direction ?? "UNKNOWN",
      };
      if (DRY) {
        if (done < 20) console.log(`  [dry-run] ${name} ->`, { ...body, email: undefined, originalSha256: undefined });
      } else {
        const reg = await api("POST", "/internal/import/calls", body);
        if (!reg.ok) throw new Error(`register ${reg.status} ${await reg.text()}`);
        const { callId, alreadyUploaded } = (await reg.json()) as { callId: string; alreadyUploaded: boolean };
        if (!alreadyUploaded) {
          const mime = AUDIO_EXT_MIME[path.extname(name).toLowerCase()]!;
          const put = await upload(callId, file, mime, hash, size);
          if (!put.ok) throw new Error(`upload ${put.status} ${await put.text()}`);
        }
      }
      totals.imported++;
    } catch (e) {
      totals.failed++;
      await appendFile(FAIL_LOG, `${email}\t${file}\t${(e as Error).message}\n`);
    }
    if (++done % 50 === 0 || done === todo.length) {
      const rate = (totals.imported / ((Date.now() - started) / 1000)).toFixed(1);
      console.log(`  ${done}/${todo.length} (${rate} files/s, ${totals.failed} failed)`);
    }
  });
}

console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s:`, totals);
if (totals.failed) console.log(`Failures listed in ${FAIL_LOG}. Re-run the same command to retry them.`);
