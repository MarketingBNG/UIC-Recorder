# Deploying UIC Recorder on Coolify

The deployment is three separate Coolify resources in one project. There's no docker-compose file and no Dockerfile; Coolify's Railpack builder builds everything (config in `railpack.json`).

## 1. `uic-db`: PostgreSQL
1. **+ New → Database → PostgreSQL** and pick image tag `postgres:18-alpine`.
2. Name it `uic-db`, set a username and a strong password, and use the database name `uic`.
3. Leave **"Make it publicly available" off**.
4. Turn on **Scheduled backups**, daily, sending them to S3/R2 or another disk.
5. Copy the **internal** connection URL, which looks like `postgresql://…@<uuid>:5432/uic`.

## 2. `uic-api`: Application
1. **+ New → Application → (your Git repo)**, build pack **Railpack**, base directory `/server`.
2. Port `8000`. Domain: `https://calls.<yourdomain>`.
3. Database migrations run automatically when the app starts (`server/railpack.json`); no pre-deployment command is needed.
4. **Persistent storage → Directory mount:** source `/data/uic-recorder/recordings` → destination `/data/recordings`.
5. **Environment variables:** see `server/.env.example`.
   - `DATABASE_URL` is the internal URL from step 1.
   - `STORAGE_DIR` is `/data/recordings`.
   - `PUBLIC_URL` is the domain above.
   - Generate `JWT_SECRET`, `SESSION_SECRET` and `WORKER_TOKEN` with `openssl rand -base64 48`.
   - Set `ADMIN_EMAILS` to your own email so you become admin on first sign-in.
6. Deploy, then open `https://calls.<yourdomain>/health`. It should return `{"ok":true}`.

## 3. `uic-worker`: Application
1. **+ New → Application → same repo**, build pack **Railpack**, base directory `/worker`.
2. No domain, and no port exposed.
3. Environment: see `worker/.env.example`.
   - `API_URL` is the **internal** address of `uic-api` (Coolify shows it, e.g. `http://<uuid>:8000`).
   - `WORKER_TOKEN` is the same value as on `uic-api`.
   - `TRANSCRIBE_PROVIDER` is `stub` until a provider is chosen.
4. Deploy. The logs should show `"worker started"`.

## Self-hosted Whisper on a rented GPU (backlog)
On any GPU machine:
```
cd worker && uv sync --extra local
API_URL=https://calls.<yourdomain> WORKER_TOKEN=... TRANSCRIBE_PROVIDER=faster_whisper WHISPER_DEVICE=cuda uv run python -m worker
```
The worker only talks to the API over HTTPS. It needs no access to the database or the disk.

## Auto-deploy
Connect the GitHub app in Coolify. Pushing to `main` then redeploys `uic-api` and `uic-worker`.

## Importing recordings you already copied
1. On `uic-api`, set `IMPORT_TOKEN` (`openssl rand -base64 48`) and redeploy.
2. On the computer that holds the copied folders (with Node 24 installed):
   ```
   cd server && npm ci
   set API_URL=https://calls.<yourdomain>
   set IMPORT_TOKEN=<same value>
   npx tsx scripts/import-existing.ts --root "D:\Recordings" --domain usaindiacfo.com --concurrency 8
   ```
   Each sub-folder of `D:\Recordings` is one person, named `ravi` or `ravi@usaindiacfo.com`. For a single person, use `--email ravi@usaindiacfo.com --dir "D:\Recordings\Ravi"` instead.
3. Add `--dry-run` first to preview the phone, name and date read from each filename.
4. It's safe to stop and re-run. Files already on the server are skipped, and failures are listed in `import-failures-<date>.log`.
5. Imported calls queue behind live calls. To finish faster, raise `WORKER_CONCURRENCY` on `uic-worker`, or run extra workers (for example on a rented GPU, see above). They all share one queue.
6. Remove `IMPORT_TOKEN` from `uic-api` when the import is finished.

## Fireflies transcription
Fireflies downloads the audio from our server, so `uic-api` must be reachable over **https** at `PUBLIC_URL`.

1. On `uic-worker`, set `TRANSCRIBE_PROVIDER=fireflies` and `FIREFLIES_API_KEY=<API key from Fireflies → Integrations>`. `FIREFLIES_MAX_WAIT_S` is optional (default 3600); it caps how long one job waits for its transcript. Redeploy. `uic-api` needs no new variables because the signed audio links use `JWT_SECRET` and `PUBLIC_URL`.
2. How a job runs:
   1. The worker asks the API to reserve the call's minutes.
   2. It gets a signed link, `PUBLIC_URL/public/audio/<callId>.<ext>?exp=…&sig=…`. The link works for 3 hours and only for that one call.
   3. It calls `uploadAudio` and polls until the transcript is ready.
   4. It saves the transcript with speakers and timestamps and reports the actual minutes.
   5. It deletes the transcript in Fireflies, unless `deleteAfterFetch` is off.
3. **Budget.** Admins change it with `PUT /api/settings/fireflies`; managers can read `GET /api/fireflies/usage`.
   - `budgetMinutes` (default 16200) is the limit per calendar month in UTC. Fireflies counts API uploads against the team's monthly minutes, and going over may be charged.
   - `liveReservePct` (default 10) keeps part of the budget for live calls. Backlog and import calls stop at the budget minus this reserve; live calls can use the whole budget.
   - `approvedBacklogCount` (default 20) is the total number of backlog and import calls that may be sent. Once it's reached, backlog sending pauses until an admin raises it. Live calls aren't affected.
   - `deleteAfterFetch` (default true) and `enabled` are on/off switches. Send `clearBlock: true` to lift a hard stop.
   - Jobs held back show as `WAITING_BUDGET` in `/api/stats` and start again by themselves. Jobs held by a gate are retried every hour; jobs held because the budget is used up wait until the next month.
4. **Hard stop.** Some Fireflies errors mean the plan, payment or quota is the problem: `paid_required`, `account_cancelled`, `require_ai_credits`, `feature_disabled`, or a message mentioning a quota or an exceeded limit. When one arrives, all Fireflies sends stop until the next month or until an admin sends `clearBlock`. `/api/stats` shows it as `fireflies.blocked` and `fireflies.lastError`.
5. **Unsupported formats.** Fireflies only accepts mp3, mp4, m4a, wav and ogg. Calls recorded as amr, 3gp, raw aac, opus or webm fail with `UNSUPPORTED_FORMAT` and aren't retried. To transcribe them, run a worker with another provider (`openai` or `faster_whisper`) and re-queue those jobs.
6. **Switching provider.** Change `TRANSCRIBE_PROVIDER` on `uic-worker` and redeploy. All workers share one queue, so you can also run two workers with different providers at the same time.

## English translation
Every new transcript also gets an English version, made by Claude Opus 5.5 on the worker.

1. On `uic-api`, `TRANSLATE_ENABLED` (default `true`) queues a `translate` job after each transcript, with the same priority as the transcription (live calls first). Set it to `false` to stop queueing new translations; existing jobs stay in the queue.
2. On `uic-worker`, set `ANTHROPIC_API_KEY`. Without it the worker doesn't take translate jobs and they wait in the queue. Optional settings are in `worker/.env.example`.
3. To translate transcripts made before this feature, an admin sends `POST /api/admin/translate-backfill` (the dashboard settings page has a button for it). It queues one job per untranslated transcript and returns `{ "queued": n }`. These run as low-priority batches.
4. A failed translation doesn't change the call: it stays `TRANSCRIBED` and shows the original transcript.
5. **Monthly cap:** the Health page card "Translation spend this month" shows the Claude cost (from token usage, batch at half price). Admins set the cap there (default 500 USD). At the cap, translate jobs stay queued until next month or a higher cap; Cliq alerts at 80% and 100%. Jobs already handed out still finish, so spend can go over by up to one batch per running worker (the cap is checked when jobs are claimed, cost is recorded when they finish, including failed attempts). No env var needed.

## Sarvam overflow (optional, off by default)
A second worker can transcribe backlog calls that are waiting because the Fireflies monthly budget is used up. It never takes live calls or calls already sent to Fireflies. Run the eval (`worker/scripts/eval_transcripts.py`) and get spend approval first.

1. Add a second worker service (same repo, `worker/`) with `TRANSCRIBE_PROVIDER=sarvam`, `SARVAM_API_KEY`, and optionally `SARVAM_MODEL` and `SARVAM_LANGUAGE`, plus the usual `API_URL` / `WORKER_TOKEN`. It needs ffmpeg in the image (added with the compression milestone).
2. Health page → Cost settings → **Send overflow backlog to Sarvam** (admin). Until this is on, a Sarvam worker gets no jobs.

## Compress old recordings
Imported recordings and phone uploads that skipped compression are often around 1 MB/min. The worker can re-encode them to the phones' format (mono AAC, 16 kHz, 24 kbps, about 5x smaller), only after the call is transcribed.

1. The worker image installs ffmpeg (`aptPackages` in `worker/railpack.json`); redeploy `uic-worker` once. Without ffmpeg (or with `COMPRESS_ENABLED=false` on the worker) it doesn't take compress jobs and they wait in the queue.
2. Health page → **Compress old recordings** (admin): **Try 5 calls** first. Check sizes and play those calls in the dashboard (seeking should work), then **Compress all**. Same as `POST /api/admin/compress-backfill` with optional `{ "limit": n }`.
3. Optional: on `uic-api`, `COMPRESS_AFTER_TRANSCRIBE=true` (default `false`) queues compression automatically after each transcript above 40 kbps.
4. Only `TRANSCRIBED` calls above 40 kbps are picked, oldest first. The new file must be smaller and within 1 s of the old duration, or the original is kept. `originalSha256` doesn't change, so phones don't re-upload. Disk saved shows under Health → Details.

## Alerts (Zoho Cliq)
The API checks every 5 minutes and posts to a Zoho Cliq channel when something breaks: no worker contact for 10 min, a Fireflies hard stop or 80%/100% of the monthly budget, more than 5% of transcription jobs failing in the last hour, queued jobs not moving for 2 h, server disk over 80%, or a phone not seen for 48 h. An ongoing problem repeats at most every 6 h, and a "Resolved" message is posted when it clears.

1. In Zoho Cliq, create a webhook token (**Bots & Tools → Webhook Tokens**). The URL is `https://cliq.zoho.in/api/v2/channelsbyname/<channel>/message?zapikey=<token>` (use your Cliq domain). Treat it as a secret.
2. On `uic-api`, set `CLIQ_WEBHOOK_URL` and redeploy. Empty means alerts are off.
3. Health page → **Send test alert** (admin) to check the channel gets messages.
