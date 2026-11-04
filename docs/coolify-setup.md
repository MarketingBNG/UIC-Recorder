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
