# Zoho CRM sync setup

Every transcribed call is sent to the matching Contact or Lead in Zoho CRM (India data centre):

- a **Call** activity (Inbound / Outbound / Missed, start time, duration, rep as owner, short summary and a link to the call in the UIC Dialer dashboard),
- a **Note** "Call transcript – <date>" with the AI summary, action items and the English transcript.

The sync is off until `ZOHO_REFRESH_TOKEN` is set on the server. It uses Zoho CRM REST API **v8**.

## 1. Create a Self Client

1. Sign in to <https://api-console.zoho.in> with a Zoho CRM **admin** account (records are created as this user when the rep has no Zoho user).
2. **Add Client** → **Self Client** → **Create**. Note the **Client ID** and **Client Secret**.

## 2. Generate a grant code

In the Self Client, open **Generate Code** and enter these scopes (comma separated):

```
ZohoCRM.modules.leads.ALL,ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.calls.ALL,ZohoCRM.modules.notes.ALL,ZohoCRM.users.READ
```

- Time duration: 10 minutes. Description: `UIC Dialer CRM sync`. Click **Create** and copy the code.

## 3. Exchange it for a refresh token (within 10 minutes)

Run on your own computer (not in a shared terminal log):

```bash
curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_GRANT_CODE"
```

The response has `refresh_token` (keep it secret; it does not expire until revoked) and `api_domain` (should be `https://www.zohoapis.in`). If you get `invalid_code`, the code expired or was already used: generate a new one.

## 4. Add the env vars in Coolify (server app → Environment Variables)

| Variable | Value |
| --- | --- |
| `ZOHO_CLIENT_ID` | Self Client ID |
| `ZOHO_CLIENT_SECRET` | Self Client secret (mark as secret) |
| `ZOHO_REFRESH_TOKEN` | refresh token from step 3 (mark as secret) |
| `ZOHO_ACCOUNTS_URL` | optional, default `https://accounts.zoho.in` |
| `ZOHO_API_URL` | optional, default `https://www.zohoapis.in` |
| `ZOHO_CRM_WEB_URL` | optional, default `https://crm.zoho.in` (for "open in Zoho CRM" links) |
| `ZOHO_CREATE_UNKNOWN_LEADS` | optional, `true` to create a Lead for unknown numbers (default `false`) |

`PUBLIC_URL` (already set) is used for the recording links. Redeploy the server. Health → **Zoho CRM sync** shows "synced / no match / errors".

If you turn on `ZOHO_CREATE_UNKNOWN_LEADS`, first add **UIC Dialer** to the Leads **Lead Source** picklist in Zoho (Setup → Modules → Leads → Fields), or new leads fail with `INVALID_DATA`.

## When calls sync

- Every minute the server picks transcribed calls with no open transcribe / translate / summarize job.
- With `SUMMARIZE_ENABLED=true` it waits for the summary, at most 30 minutes after the transcript.
- Automatically: calls whose transcript changed in the last 48 hours. Older calls: Health → **Sync last 30 days** (admin).
- Matching: Zoho phone search on the last 10 digits, Contacts first, then Leads; newest modified wins.
- No match: shown as "No matching lead or contact" (retried by the 30-day backfill or the call's **Resync to CRM** button).
- A re-transcribed or newly summarized call updates the same Call and Note (no duplicates).
- Errors on one call retry with backoff (2, 4, 8 … minutes, max 6 h, 8 tries). After that, use **Resync to CRM**.
- Auth / scope errors (bad or revoked refresh token, `OAUTH_SCOPE_MISMATCH`), Zoho 5xx / rate limits and network errors pause the whole sync instead (5, 10, 20, 40, then every 60 minutes) without using up any call's tries. With `CLIQ_WEBHOOK_URL` set, one Cliq alert goes out ("Zoho CRM sync failing …") and a "Resolved" message when it works again. Health shows "Paused".
- Each call is leased to one server while it syncs, so two containers during a rolling deploy never send the same call twice.
- Owner: the Zoho user with the rep's email; otherwise the Self Client user.

## Revoking

Zoho → <https://accounts.zoho.in> → Security → Connected Apps, or delete the Self Client. Then clear `ZOHO_REFRESH_TOKEN` in Coolify.
