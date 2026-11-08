# Phone rollout guide

How to build, sign, publish and set up UIC Recorder on staff phones. Work through it once per phone.
Screenshots: add them under `docs/img/rollout/<brand>-<step>.png` when you do the first phone of each brand
(the steps below name each screen so the screenshots can be matched later).

## 1. Release key (once)

The release key lives outside the repo. Never commit it or its password.

```
keytool -genkeypair -v -keystore C:\Users\<you>\keys\uic-release.jks -alias uic -keyalg RSA -keysize 4096 -validity 10000
```

Add to `%USERPROFILE%\.gradle\gradle.properties` (not the repo's):

```
uic.keystore=C:/Users/<you>/keys/uic-release.jks
uic.keystorePassword=<password>
uic.apiUrl=https://<server>
uic.googleWebClientId=<web client id>.apps.googleusercontent.com
```

The key alias must be `uic` and the key password is the same as the store password (see `android/app/build.gradle.kts`).
Back up the `.jks` file and its password somewhere safe (password manager): phones only accept updates signed with the same key.

Print the fingerprints (needed for Google sign-in and developer verification):

```
keytool -list -v -keystore C:\Users\<you>\keys\uic-release.jks -alias uic
```

## 2. Google developer verification (Android sideloading rules)

From 2026 Google requires apps installed on certified Android phones, including sideloaded APKs, to come from a
verified developer. Do this once before the rollout:

1. Sign up at the Android Developer Console (developer verification) with the company Google account
   (organisation account: needs the D-U-N-S number and a company website/email).
2. Complete identity verification for the organisation.
3. Register the package name `com.usaindiacfo.uicrecorder`.
4. Add the **release key SHA-256** fingerprint from step 1 to that package and prove ownership if asked
   (Google may ask you to upload an APK signed with the key that contains a token file it gives you).
5. Keep using the same key for every release.

Until verification is done, installs may show warnings or be blocked on newer Android versions.

## 3. Build and publish a release

1. Bump `versionCode` (and `versionName`) in `android/app/build.gradle.kts`. The in-app updater only offers a higher `versionCode`.
2. Build: `cd android && ./gradlew :app:assembleRelease` (JAVA_HOME = Android Studio `jbr`). The build refuses to run without an `https://` `uic.apiUrl`.
3. The APK is `android/app/build/outputs/apk/release/app-release.apk`. Rename it, e.g. `uic-recorder-0.2.0.apk`.
4. `sha256sum uic-recorder-0.2.0.apk`
5. Copy it to the server storage folder `apk/` (inside the mounted storage volume, so it survives redeploys).
6. Set the published version (server database, `settings` row 1):
   ```sql
   UPDATE settings SET latest_app = '{"versionCode": 2, "versionName": "0.2.0", "sha256": "<sha256>", "fileName": "uic-recorder-0.2.0.apk"}' WHERE id = 1;
   ```
7. Phones see the update banner on next start; the APK is checked against the SHA-256 before install.

The first install on each phone is by hand (share the APK link or copy the file).

## 4. Per-phone setup (all brands)

1. Install the APK. Allow "Install unknown apps" for the browser/file manager when asked.
2. Open UIC Recorder, sign in with the company Google account.
3. Follow the in-app **Set up this phone** checklist until every item is ticked.
4. Make a 1-minute test call, wait a few minutes, check the call appears on the dashboard.
5. On the dashboard **Sync health** page check the phone shows: not "Permissions missing", not "Throttled",
   not "Calls but no recordings", and a dialer that is not Google Phone.

### Restricted settings (Android 13+, sideloaded apps)

If "Allow" for the call log shows **Restricted setting**:
1. In the app tap **Open App info** (or Settings > Apps > UIC Recorder).
2. Tap **⋮** (top right) > **Allow restricted settings**, confirm with the PIN/fingerprint.
3. Go back to UIC Recorder and tap **Allow** again.

The ⋮ menu only shows the option after the permission was refused once.

### Google Phone dialer

Google Phone stores recordings privately (and announces them), so UIC Recorder cannot read them. Use the phone
maker's own dialer as the default Phone app. The setup screen warns when Google Phone is the default.

## 5. Per brand

| Brand | Auto-record | Battery | Autostart |
|---|---|---|---|
| **Samsung** (One UI) | Phone app > ⋮ > Settings > Record calls > Auto record calls: On, All calls | Settings > Apps > UIC Recorder > Battery: **Unrestricted**. Settings > Battery > Background usage limits: remove from Sleeping / Deep sleeping apps | No separate screen; "Never sleeping apps": add UIC Recorder |
| **Xiaomi / Redmi / Poco** (MIUI / HyperOS) | Phone > Settings > Call recording > Record calls automatically: On, All numbers | App info > Battery saver: **No restrictions** | Security app > Permissions > **Autostart**: On (setup "Open autostart" button) |
| **Oppo** (ColorOS) | Phone > Settings > Call recording > Auto-record all calls | App info > Battery usage: Allow background activity, Allow auto launch | Settings > Apps > Auto launch: On |
| **Realme** (realme UI) | Same as Oppo | Same as Oppo | Same as Oppo |
| **OnePlus** (OxygenOS 12+) | Phone > Settings > Call recording > Auto-record (region dependent) | App info > Battery: **Unrestricted** | Same screen as Oppo ("Auto launch") |
| **Vivo / iQOO** (Funtouch / OriginOS) | Phone > Settings > Call recording > Auto record all calls | Settings > Battery > Background power consumption: **Allow** | i Manager > App manager > **Background startup** / Autostart: On |

Lock the app in Recents (swipe down on its card, or long-press > Lock) on Xiaomi, Oppo, Realme, Vivo.

If the Health page shows **Throttled (RARE/RESTRICTED)**: the phone barely runs background work. Open the app daily,
recheck the battery setting, and on Samsung remove it from sleeping apps.
If it shows **Calls but no recordings**: auto-record is off, or recordings go to a folder the app can't see
(open setup > "Scan phone again" / "Choose folder").

## 6. Performance (baseline profile and benchmarks)

Module `android/baselineprofile` (needs a connected phone; nothing runs on a PC alone). Use an Android 10 phone with
2–3 GB RAM, signed in, with some calls in the list.

- Generate the profile:
  `./gradlew :baselineprofile:connectedBenchmarkAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.usaindiacfo.uicrecorder.baselineprofile.BaselineProfileGenerator`
  then copy the `*-baseline-prof.txt` from `baselineprofile/build/outputs/connected_android_test_additional_output/`
  to `android/app/src/main/baseline-prof.txt` and commit it. `profileinstaller` installs it with the app.
- Measure: `./gradlew :baselineprofile:connectedBenchmarkAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.usaindiacfo.uicrecorder.baselineprofile.StartupBenchmark`
  (cold start with/without profile, call list scroll frame timing). Results are in the same output folder.
