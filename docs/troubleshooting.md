# Problems we hit and how we fixed them

Newest first. One line each for the problem, cause and fix.

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
