# Problems we hit and how we fixed them

Newest first. One line each for the problem, cause and fix.

## `npm test` failed in global setup: `EPERM rm server/.pgtest` (Zoho CRM sync review, local dev)
- **Cause:** an orphaned `postgres.exe` io_worker from an earlier test run (its postmaster had exited) still held the test data dir.
- **Fix:** found it with `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'"` (orphan: parent PID gone) and stopped only that PID; the dev DB on `.pgdata` was left running.

## Bash heredoc with TypeScript template literals failed: "unexpected EOF while looking for matching quote" (Zoho CRM sync review, local dev)
- **Fix:** same as before: write the text to a scratch file with the Write tool, then append it with Python.

## Zoho CRM test counted the OAuth token POST as a CRM write (Zoho CRM sync, local dev)
- **Cause:** the fake fetch records every request, including `POST /oauth/v2/token`.
- **Fix:** the tests filter out `oauth` URLs when counting Call / Note writes.

## Zoho "record deleted" update was not recognised (Zoho CRM sync, local dev)
- **Cause:** Zoho puts per-record errors such as `INVALID_DATA` inside `data[0]`, not at the top level.
- **Fix:** `ZohoClient.request` reads the code from `data[0]` when the top level has none, so a deleted Call is recreated.

## Edit script left a raw BOM / real line breaks in TypeScript strings (M5 review fixes, local dev)
- **Cause:** the CSV code had a literal U+FEFF character, so a text match on the escaped form failed; a heredoc turned `

` escapes into real line breaks.
- **Fix:** the BOM is now a named `"﻿"` constant in `src/calls/export.ts`; the broken line was rewritten with the escapes built explicitly.

## Local gitleaks run blocked (M5 review fixes, local dev)
- **Cause:** downloading and running the gitleaks release binary was not permitted in the local session.
- **Fix:** none locally; the CI `secrets` job is the first real scan. Check its result on the first PR.

## Inline Python edit script failed in the Bash tool: "unexpected EOF while looking for matching quote" (M5, local dev)
- **Cause:** a heredoc'd Python script containing TypeScript template literals (backticks) inside triple-quoted strings confused the shell wrapper.
- **Fix:** wrote the edit script to a file in the scratchpad and ran `python <file>` instead.

## gitleaks could not be run locally (M5, local dev)
- **Cause:** Docker Desktop was not running, so the `zricethezav/gitleaks` image could not start.
- **Fix:** none needed locally; the CI `secrets` job runs it. `.gitleaks.toml` allowlists test fixtures with fake tokens.

## Android unit test crashed with ExceptionInInitializerError (M4)
- **Cause:** the test called a helper on `SetupChecks`, whose init reads `Build.MANUFACTURER` (null in JVM unit tests).
- **Fix:** moved the pure rule (`needsRestrictedSettings`) to `DeviceHealth`, which has no Android state at init.

## Dashboard build failed: "stream did not contain valid UTF-8" in Health.tsx (M4)
- **Cause:** a Python edit script on Windows wrote the file in cp1252, so an inserted en dash became an invalid byte.
- **Fix:** rewrote the byte as UTF-8; edit scripts now open files with `encoding="utf-8"`.

## Two retention claims at once failed with a unique-key error (M3 review fixes)
- **Cause:** Prisma `upsert` is not atomic; two concurrent calls both tried to insert the `retention:last_run` row.
- **Fix:** create the row with `createMany({ skipDuplicates: true })`, then claim with a conditional `updateMany`.

## Test Postgres would not start after a test run was stopped mid-way (M3 review fixes)
- **Cause:** stopping `npm test` left an orphan test `postgres.exe` (an `io_worker` of `.pgtest`) holding shared memory.
- **Fix:** killed only the orphan process whose parent was gone; left the dev database (`.pgdata`) running.

## New Android file under `data/db/` was not picked up by git (M3)
- **Cause:** the root `.gitignore` rule `data/` (meant for server recordings) also matches the app's `data` package.
- **Fix:** added `ClientHash.kt` with `git add -f`; check `git status` for new files under `.../uicrecorder/data/`.

## Test database would not start while the dev database was running (M3, local dev)
- **Cause:** `npm test` reuses `.pgtest` on port 54339; a leftover test Postgres child process still held it ("pre-existing shared memory block is still in use").
- **Fix:** ran the tests on a separate copy with `TEST_DB_DIR=.pgtest-m3 TEST_DB_PORT=54349 npx vitest run`, leaving the dev database (`.pgdata`, port 54329) alone.

## `npx vitest run test/privacy.test.ts` found no tests (M3, local dev, Windows)
- **Cause:** the path filter `test/privacy.test.ts` did not match the Windows file path vitest compares it with.
- **Fix:** filter by name only: `npx vitest run privacy`.

## Two compress jobs for one call could delete the saved recording (M2b review)
- **Cause:** both jobs wrote `<callId>-c.m4a`; the losing job's cleanup removed the file the winner had just swapped in.
- **Fix:** the file is now `<callId>-c-<jobId>.m4a`, a partial unique index allows one open compress job per call, and a resent upload after a lost response returns the earlier result instead of an error.

## Compressed upload test hung when the file was too big (M2b, local dev)
- **Cause:** the size limit fired mid-stream and the injected request never got its response.
- **Fix:** the API rejects a compressed upload whose `Content-Length` is not smaller than the original before reading the body; the stream limit stays as a backstop.

## Bash heredoc edits silently did nothing (M2b, local dev)
- **Cause:** a long heredoc with TypeScript template strings broke the shell's quote parsing, so no file was written.
- **Fix:** wrote new files with the editor tool and ran edit scripts from a file.

## Sarvam transcripts came out one word per line (M2 review)
- **Cause:** each Sarvam word timestamp became its own segment, and the text was joined from segments, so Claude translated word by word.
- **Fix:** one segment per 25 s chunk (word times kept under `words`), text from the chunk transcripts.

## Claude spend from failed translate attempts was not counted (M2 review)
- **Cause:** cost was written only on a successful translation post.
- **Fix:** failed attempts send `model` + `usage` with the failure result; the API adds that cost to the job.

## Shell edit refused by the command safety check (local dev)
- **Cause:** an inline Python heredoc containing `$` template strings could not be parsed safely by the Bash tool.
- **Fix:** wrote the edit script to a file and ran it with `python <file>`.

## Alert tests saw extra failed jobs from other tests (local dev)
- **Cause:** the new `failed_attempt_at` column wasn't cleared between tests, so failures from earlier tests counted in the hour window.
- **Fix:** the alerts test `beforeEach` now clears `failed_attempt_at` along with `finished_at`.

## Bash heredoc failed with "unexpected EOF while looking for matching `'`" (local dev)
- **Cause:** a long test file written through a shell heredoc contained characters the Git Bash wrapper mis-parsed.
- **Fix:** wrote the file with the editor instead of `cat <<'EOF'`.

## Worker translate claim failed with 400 Bad Request
- **Cause:** the worker asked for up to 100 translate jobs per claim; the API allows at most 20.
- **Fix:** the worker caps each claim at 20 (`CLAIM_MAX` in `worker/worker/translator.py`); a batch of 100 fills over several claims.

## Worker crashed on deploy: "No module named 'anthropic'"
- **Cause:** Railpack installs from `worker/requirements.txt`, which wasn't regenerated after adding a package to `pyproject.toml`.
- **Fix:** after changing worker dependencies run `uv export --no-dev --no-hashes --format requirements-txt -o requirements.txt` and commit it.

## Whisper crashed: "open() got an unexpected keyword argument 'metadata_errors'"
- **Cause:** PyAV 19 removed an option that faster-whisper 1.2.1 still passes.
- **Fix:** pinned `av==17.0.1` next to faster-whisper in `worker/pyproject.toml`.

## Samsung phone not detected over USB ("USB debugging is disabled by Auto Blocker")
- **Cause:** Samsung's Auto Blocker blocks USB debugging (and installs from outside the Play Store).
- **Fix:** Settings > Security and privacy > Auto Blocker: off; then turn on USB debugging and tap Allow. Turn Auto Blocker back on after testing.

## Fireflies key not found in worker/.env
- **Cause:** the key was pasted into `server/.env`, with a space before `=` (`FIREFLIES_API_KEY ="..."`).
- **Fix:** the worker reads `worker/.env`; write `KEY="value"` with no spaces around `=`.

## Server build would fail on Coolify (Railpack skips dev packages)
- **Cause:** `typescript` and `@types/node` were dev-only, so `npm run build` failed after a production install.
- **Fix:** moved both to regular dependencies; tested with `npm ci --omit=dev` then `npm run build`.

## Site returned 502 on every other request
- **Cause:** uic-worker was cloned from uic-api and inherited its routing labels, so the proxy sent half the traffic for calls.usaindiacfo.us to the worker. The clone also inherited the `npx prisma migrate deploy` pre-deploy command, which fails in the Python worker.
- **Fix:** cleared `custom_labels`, `fqdn` and the pre/post-deploy commands on uic-worker and redeployed it. When cloning an app in Coolify, check those fields.

## Coolify: database had no tables after first deploy
- **Cause:** Coolify skips the pre-deployment command on an app's first deploy ("No running containers found").
- **Fix:** migrations now run on every container start (`server/railpack.json` start command).

## Coolify: Nixpacks deprecated
- **Cause:** Nixpacks is in maintenance mode; Coolify 4.6 defaults to Railpack.
- **Fix:** replaced `nixpacks.toml` with `railpack.json` in `server/` and `worker/`; pick **Railpack** in Coolify.

## New recordings didn't upload automatically
- **Problem:** a new recording only uploaded when the app had just been open.
- **Cause:** the app's battery setting was "Restricted", so Android blocked its background jobs.
- **Fix:** set Battery to "Unrestricted" (setup now warns about this). After that, uploads start ~50 s after the call ends (Android batches "new file" events).

## Staff don't know where their recorder saves calls
- **Problem:** recordings never uploaded because the phone's recorder folder wasn't on our list.
- **Cause:** every brand saves call recordings in a different folder.
- **Fix:** setup now scans the whole phone for folders that look like call recordings and lists them with checkboxes; "Choose folder" is the manual fallback.

## Battery step stayed red after changing battery settings
- **Problem:** user changed battery settings but setup still said battery optimisation was on.
- **Cause:** the app was set to "Restricted", a separate setting from "Don't optimise"; only one was changed.
- **Fix:** the Allow button now opens Android's one-tap "Allow" box, and setup warns about "Restricted" with an App settings button (Battery > "Unrestricted").

## App can't reach the server from the emulator / USB phone
- **Problem:** "Can't reach the server" after Google sign-in.
- **Cause:** the phone couldn't reach the dev server's port on this PC.
- **Fix:** debug builds use `http://localhost:8000`, forwarded to the PC with `adb reverse tcp:8000 tcp:8000`. Re-run that command each time the emulator or phone is (re)connected.

## Emulator window off screen
- **Fix:** click it, then `Win + ↑`; or `Alt + Space` → Move.

## Android Studio didn't install via winget
- **Cause:** silent install needs admin; the Windows prompt never appeared or was missed.
- **Fix:** download it from developer.android.com/studio and install by hand.

## Android build tried to download Java 25
- **Cause:** `android/gradle/gradle-daemon-jvm.properties` asked for a Java 25 toolchain (fails when foojay.io is unreachable).
- **Fix:** deleted the file; builds use the installed JDK 21 (`JAVA_HOME`).

## Local Postgres won't start: "shared memory block is still in use"
- **Cause:** leftover `postgres.exe` processes after a force-kill.
- **Fix:** stop the old `postgres.exe` processes from this project, then `npm run dev:db` again.

## Fresh job locks looked stale (jobs reclaimed too early)
- **Cause:** local Postgres ran in IST, so `now()` comparisons were off by 5.5 h.
- **Fix:** every DB connection is pinned to UTC (`server/src/db.ts`).

## Filenames like `incoming_…` not recognised as incoming
- **Cause:** regex `\b` treats `_` as part of a word.
- **Fix:** letter-only lookarounds in `server/src/calls/filename.ts`.

## `prisma migrate dev` hangs
- **Cause:** it waits for an interactive prompt.
- **Fix:** use `npx prisma migrate deploy` / `migrate status` in scripts.

## Prisma generated code fails with ESM imports
- **Fix:** generator option `importFileExtension = "js"`.

## `npm audit` flagged `glob`
- **Fix:** `overrides` pins `glob` to 14.0.3 in `server/package.json`.

## Server tests fail: "pre-existing shared memory block is still in use"
- **Cause:** an orphaned `postgres.exe` child from an earlier test run (parent is not the dev DB) still holds shared memory.
- **Fix:** find `postgres.exe` processes whose parent isn't the dev DB postmaster and stop only that one, then rerun `npm test`.

## CRM tests passed or failed at random
- **Cause:** the shared test DB holds over 1,000 calls, so `candidates(1000)` sometimes missed the test's own call.
- **Fix:** tests use `candidates(1_000_000)`.
