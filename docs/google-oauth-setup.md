# Google sign-in (OAuth) setup

The dashboard and the Android app both sign in with Google. The server checks the ID token audience against the
**web** client ID. Do this in Google Cloud Console with the company account.

## 1. Project and consent screen
1. console.cloud.google.com > create (or pick) a project, e.g. "UIC Recorder".
2. APIs & Services > OAuth consent screen (Google Auth Platform > Branding): app name "UIC Recorder", support email,
   authorised domain = the dashboard's domain.
3. Audience: **Internal** (only company Workspace accounts). Scopes: `openid`, `email`, `profile` only.

## 2. Web client (dashboard + token audience)
1. Clients > Create client > **Web application**.
2. Authorised JavaScript origin: `https://<dashboard host>`.
3. Authorised redirect URI: `https://<dashboard host>/auth/google/callback`.
4. Put the client ID in the server env `GOOGLE_WEB_CLIENT_ID` and the secret in `GOOGLE_WEB_CLIENT_SECRET` (Coolify).
5. Put the same client ID in `%USERPROFILE%\.gradle\gradle.properties` as `uic.googleWebClientId` for app builds.

## 3. Android clients (one per signing key)
Credential Manager needs an Android client for the package and each key that signs installed builds:
1. Clients > Create client > **Android**, package `com.usaindiacfo.uicrecorder`, SHA-1 of the **release** key
   (`keytool -list -v -keystore <release.jks> -alias uic`).
2. Optional: a second Android client with the debug key SHA-1 (`keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android`) for local testing.

No Android client ID goes into the app; Google matches package + key automatically.

## 4. Restrict to the company
Set `ALLOWED_DOMAIN` on the server (e.g. `usaindiacfo.com`) so only that Workspace domain can sign in.

## Troubleshooting
- App says "No credentials available" / sign-in closes at once: the Android client SHA-1 does not match the key that signed the installed APK.
- Server rejects the token (401): `GOOGLE_WEB_CLIENT_ID` differs from `uic.googleWebClientId` used to build the app.
