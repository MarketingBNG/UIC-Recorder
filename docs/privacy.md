# Privacy and data handling

This note is for the business owner and whoever reviews compliance. **It is not legal advice. Have a lawyer familiar with India's Digital Personal Data Protection Act, 2023 (DPDP Act) and the DPDP Rules review it, along with the notice text below, before relying on it.**

## What the system stores

- **Call recordings** (audio) from staff phones, stored on the company server's disk. There is no off-site backup at the moment (owner's decision).
- **Call details:** phone number, contact name as saved on the phone, direction, time, duration, and which staff member's phone recorded it.
- **Transcripts** in the original language and an English translation.
- **Audit log:** who played, downloaded, searched or deleted calls, and who changed users, phones or settings.

## Processors (third parties that receive data)

| Processor | What they receive | Why | Notes |
|---|---|---|---|
| **Fireflies.ai** | Call audio, through a short-lived signed link | Transcription | The worker deletes the transcript from Fireflies after fetching it (`deleteAfterFetch` setting). |
| **Anthropic (Claude API)** | Transcript text | English translation | API data isn't used for model training under Anthropic's commercial terms; confirm the current retention terms. |
| **Sarvam AI** (only if switched on) | Call audio | Overflow transcription when the Fireflies monthly budget is used up | Off by default (Health page, "Send overflow backlog to Sarvam"). |
| **Google** | Staff email and name at sign-in | Sign-in (Google account) | No call data. |
| **Zoho Cliq** (only if the webhook is set) | Alert text: counts, phone model, staff name | Ops alerts | No call content. |

Check each processor's data processing agreement and where it stores data before go-live. Fireflies, Anthropic and Sarvam may process data outside India.

## Controls in the app

All of these default to off (the owner's decision) unless noted.

- **Business calls only** (Settings, device sync): phones skip calls with numbers saved in the phone's contacts, unless the number is on the **client list**. Numbers not saved in contacts and hidden numbers still upload.
  - The phone needs the Contacts permission. Without it, those calls wait.
  - Phones download an unsalted SHA-256 hash of each client number instead of the number. This hides the list from casual view only: a 10-digit number's hash can be reversed by trying every number in minutes, so any signed-in phone could recover the list. Treat the client list as visible to staff.
  - The decision is made when a recording uploads, so client-list changes apply to recordings still waiting.
  - A call skipped this way is never uploaded.
- **Excluded numbers** (per user, Users page): never uploaded. This is on whenever numbers are listed.
- **Retention** (Settings → Privacy): off means recordings are kept forever. When set to N months, the API deletes the audio files of calls older than N months once a day and keeps the transcripts.
  - Calls with work still running are skipped until that work finishes.
  - Every run that deletes something writes a "Retention deleted audio" row to the audit log.
  - Deleted audio can't be recovered, and there is no backup.
- **Mask Aadhaar and card numbers** (Settings → Privacy): the worker replaces 12-digit Aadhaar numbers that pass the Verhoeff check and card numbers that pass the Luhn check with their last 4 digits, before the transcript is stored. It masks both the original transcript and the English translation.
  - PAN and GSTIN are kept on purpose, because they are business identifiers.
  - Limits:
    - Masking only applies to transcripts made after it is switched on.
    - Numbers spoken as words ("nine eight seven…") or split across speaker turns are not caught.
    - The audio still contains them.
- **Audit log** (admin page, dashboard and app): lists plays, downloads (`?download=1`), searches, deletions, user, phone and settings changes, client-list edits and retention runs.
- **Upload rate limit:** each phone can upload at most `UPLOAD_RATE_PER_HOUR` recordings an hour (default 600).
- **Access:** agents see only their own calls, managers see their team's calls, and admins see all calls. Sessions use Google sign-in. Deactivating a user signs their phones out.

## Notice text template (for staff and, where needed, callers)

Adapt this with your lawyer. Under the DPDP Act a notice should say what is collected, why, how to withdraw consent or raise a grievance, and how to complain to the Data Protection Board.

> **Call recording notice: [Company name]**
>
> Calls made or received on company work phones, or on personal phones enrolled in the UIC Recorder app, are recorded. We use the recordings and their transcripts for quality, training, record-keeping and resolving client queries.
>
> **What we collect:** call audio, the phone number, call time and duration, and a written transcript and English translation of the call.
>
> **Who processes it:** our own servers, and our service providers for transcription and translation (Fireflies.ai, Anthropic and, if enabled, Sarvam AI). They may process data outside India.
>
> **How long we keep it:** [until deleted by an admin / audio for N months, transcripts for N years].
>
> **Your rights:** you can ask to access, correct or erase your personal data, or withdraw consent for recording where consent is the basis. Contact our grievance officer: [name, email, phone]. If you are not satisfied with our response, you can complain to the Data Protection Board of India.
>
> [For callers, a short version played or said at the start of the call: "This call may be recorded and transcribed for quality and record-keeping. Tell us if you prefer it not to be."]

## Open items for the owner

- Get a legal review of this document, the notice and the consent basis for recording staff and clients.
- Decide on a retention period. It is currently off, so everything is kept forever.
- Decide whether masking should be on.
- Sign or confirm data processing agreements with Fireflies, Anthropic and, if used, Sarvam.
- There is no off-disk backup, so a server disk failure loses the recordings. This was a deliberate decision; revisit it.
