# Problems we hit and how we fixed them

Newest first. One line each for the problem, cause and fix.

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
