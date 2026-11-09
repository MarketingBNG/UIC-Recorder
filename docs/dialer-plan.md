# Dialer and Activity Tracker plan

Adds a dialer to UIC Recorder so reps call any number from their own phones, and the dashboard shows every call, recording and follow-up in one place.

## Why

From the 6 Nov 2026 meeting: leads are being lost. We need an activity tracker that tracks calls (picked up or not), call recordings, WhatsApp messages and Gmail replies. It goes in one dashboard as a second tab. Reps: Nafis, Nilesh, Ravi, Sadhana.

## Decisions (8 Nov 2026)

- **No lead import.** Reps use the app like a normal dialer: type or paste any number. No Zoho CRM, Google Sheets or CSV is needed.
- **Contacts are created automatically** the first time a number is called. The rep can add a name and company later.
- **Owner** is the rep who first called the number.
- **All four reps are on Android.**
- **Gmail replies come later**, not in the first version.
- The app opens the phone's own dialer (`ACTION_DIAL`). It does not replace the phone's calling screen.

## Cost

Free apart from the reps' normal phone plans. Calls go out on the rep's own SIM, recordings come from the phone's built-in recorder, WhatsApp uses free `wa.me` links, and hosting is already on Coolify.

## What already exists

- Android app finds call recordings, matches them to the call log and uploads them.
- Server and dashboard: calls list, call detail, users, health.
- Transcripts (Whisper or Fireflies) with English translation.
- Alerts to Zoho Cliq.

## What to add

### Android app
1. **Dialer screen**: number pad plus paste, and a list of recent contacts with search.
2. **Tap to call**: opens the phone dialer with the number (`ACTION_DIAL`), so it uses the rep's SIM.
3. **Outcome after the call**: shown when the rep returns to the app. Interested, Call back (with a date), Not interested, No answer, plus a note. Call duration and answered/missed come from the call log.
4. **Contact details**: optional name and company for a number.
5. **WhatsApp button**: opens `wa.me/<number>`; the app logs that a chat was opened.
6. **Follow-ups due**: list of call-backs due today and overdue.
7. Existing sync links the uploaded recording to the contact by phone number.

### Server
1. Phone numbers stored in one format (E.164, default country India) so +91, 0-prefixed and 10-digit forms match.
2. `Contact` table: phone (unique), name, company, owner (rep), status, next follow-up date.
3. `Activity` table: contact, rep, type (call, WhatsApp, note), outcome, note, time, linked `Call` if any.
4. Link existing and new `Call` rows to contacts by phone number.

### Dashboard: Activity Tracker tab
1. Contact list with status, owner, last activity and next follow-up.
2. Per-contact timeline: calls with recordings and transcripts, WhatsApp, notes.
3. Per-rep view: calls made, answered, talk time, follow-ups due today.
4. Overdue follow-ups list.

## Later
- Gmail replies via the Gmail API.
- Zoho CRM sync (copy contacts and outcomes into the CRM).
- WhatsApp Business API for real message tracking (paid, about ₹0.12–0.86 per message).

## Limits
- Android only.
- Recording depends on the phone's built-in recorder; some models block it.
- Calls are made from mobiles, not laptops.
- WhatsApp via `wa.me` only logs that a chat was opened, not the messages.
- Android does not tell the app exactly when a call opened with `ACTION_DIAL` ends, so the outcome prompt appears when the rep comes back to the app.
