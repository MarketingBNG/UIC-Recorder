"""Fireflies.ai transcription over its GraphQL API.

Flow per job (all coordination goes through our API, never the DB):
  reserve minutes (server-side budget) -> signed public audio URL -> uploadAudio
  -> poll transcripts until the sentences are ready -> report actual minutes
  -> optionally deleteTranscript (privacy).

Docs: https://docs.fireflies.ai/graphql-api/mutation/upload-audio
      https://docs.fireflies.ai/graphql-api/query/transcripts
      https://docs.fireflies.ai/graphql-api/query/transcript
      https://docs.fireflies.ai/graphql-api/mutation/delete-transcript
      https://docs.fireflies.ai/fundamentals/limits
      https://docs.fireflies.ai/miscellaneous/error-codes
"""

from __future__ import annotations

import math
import re
import time
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from ..config import Settings
from . import Deferred, PermanentError, Transcript

if TYPE_CHECKING:
    from ..main import Api

log = structlog.get_logger()

URL = "https://api.fireflies.ai/graphql"

# Fireflies accepts mp3, mp4, wav, m4a, ogg. Everything else (amr, 3gp, raw aac,
# opus, webm...) fails with UNSUPPORTED_FORMAT so it can be retried with another provider.
SUPPORTED_MIME = {
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4",
    "audio/wav", "audio/x-wav", "audio/wave", "audio/ogg",
}
MAX_BYTES = 200 * 1024 * 1024

# Errors that mean "stop sending until an admin looks": plan, payment, quota.
HARD_STOP_CODES = {"paid_required", "account_cancelled", "require_ai_credits", "feature_disabled"}
HARD_STOP_TEXT = re.compile(
    r"quota|limit (has been )?(reached|exceeded)|exceed(ed|s)? .*limit|insufficient .*(credit|minute)|upgrade (your )?plan",
    re.I,
)

# Rate limiting is transient; never mistake it for a quota hard stop.
RATE_TEXT = re.compile(r"rate|too many|per minute|requests", re.I)

UPLOAD = """mutation uploadAudio($input: AudioUploadInput) {
  uploadAudio(input: $input) { success title message }
}"""
FIND = """query Find($keyword: String, $fromDate: DateTime) {
  transcripts(keyword: $keyword, scope: "title", fromDate: $fromDate, mine: true, limit: 10) { id title }
}"""
GET = """query Get($id: String!) {
  transcript(id: $id) {
    id title duration
    meeting_info { silent_meeting summary_status }
    sentences { index speaker_name text start_time end_time }
  }
}"""
DELETE = """mutation Delete($id: String!) { deleteTranscript(id: $id) { id } }"""
LEFTOVERS = """query Leftovers($toDate: DateTime, $skip: Int) {
  transcripts(keyword: "uic-", scope: "title", toDate: $toDate, mine: true, limit: 50, skip: $skip) { id title }
}"""
OUR_TITLE = re.compile(r"^uic-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")


class HardStop(Exception):
    """Fireflies refused for plan/quota/payment reasons; all sends must stop."""


class FirefliesError(Exception):
    def __init__(self, code: str | None, message: str) -> None:
        super().__init__(f"{code or 'error'}: {message}")
        self.code = code


class FirefliesProvider:
    name = "fireflies"
    remote = True  # needs no local audio file; works through the API (see main.process_job)

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None, sleep=time.sleep) -> None:
        if not settings.fireflies_api_key:
            raise SystemExit("FIREFLIES_API_KEY is required for TRANSCRIBE_PROVIDER=fireflies")
        self.max_wait_s = settings.fireflies_max_wait_s
        self.sleep = sleep
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {settings.fireflies_api_key}"},
            timeout=httpx.Timeout(60, connect=10),
            transport=transport,
        )

    # Kept for the Provider protocol; Fireflies pulls audio from a URL instead.
    def transcribe(self, *_: Any) -> Transcript:
        raise PermanentError("fireflies provider runs via transcribe_job")

    # ---- GraphQL ------------------------------------------------------------

    def _gql(self, query: str, variables: dict, max_tries: int = 6, retry_transport: bool = True) -> dict:
        for attempt in range(1, max_tries + 1):
            try:
                res = self.client.post(URL, json={"query": query, "variables": variables})
            except httpx.TransportError:
                if attempt == max_tries or not retry_transport:
                    raise
                self.sleep(min(2**attempt, 60))
                continue
            body: dict = {}
            try:
                body = res.json()
            except ValueError:
                pass
            errors = body.get("errors") or []
            codes = [_code(e) for e in errors]
            if res.status_code == 429 or "too_many_requests" in codes:
                wait = _retry_after(res, errors)
                log.warning("fireflies rate limited", wait_s=wait, attempt=attempt)
                if attempt == max_tries:
                    raise FirefliesError("too_many_requests", "rate limited")
                self.sleep(wait)
                continue
            for e, code in zip(errors, codes):
                msg = str(e.get("message", ""))
                if code in HARD_STOP_CODES or (HARD_STOP_TEXT.search(msg) and not RATE_TEXT.search(msg)):
                    raise HardStop(f"{code or 'error'}: {msg}"[:1000])
            if res.status_code >= 500 and not errors:
                if attempt == max_tries:
                    res.raise_for_status()
                self.sleep(min(2**attempt, 60))
                continue
            if errors:
                e = errors[0]
                raise FirefliesError(codes[0], str(e.get("message", "")))
            if res.status_code == 401:
                raise PermanentError("Fireflies 401: bad FIREFLIES_API_KEY")
            res.raise_for_status()
            return body.get("data") or {}
        raise FirefliesError(None, "unreachable")

    # ---- Job flow -------------------------------------------------------------

    def transcribe_job(self, api: Api, job: dict, language: str | None) -> Transcript:
        job_id, call_id = job["jobId"], job["callId"]
        mime = (job.get("mimeType") or "").lower()
        if mime not in SUPPORTED_MIME:
            raise PermanentError(f"UNSUPPORTED_FORMAT: Fireflies does not accept {mime or 'unknown type'}; "
                                 "retry this call with another provider")

        r = api.fireflies_reserve(job_id)
        if r.get("status") != "reserved":
            raise Deferred(f"{r.get('reason')}: {r.get('message')} (retry at {r.get('retryAt')})")
        reservation = r["reservationId"]
        uploaded = bool(r.get("uploaded"))
        title = f"uic-{call_id}"
        try:
            if not uploaded:
                signed = api.fireflies_audio_url(call_id)
                if not signed["url"].startswith("https://"):
                    raise PermanentError("CONFIG: PUBLIC_URL must be https for Fireflies to fetch audio")
                inp: dict[str, Any] = {
                    "url": signed["url"],
                    "title": title,
                    "client_reference_id": call_id,
                    # Short calls are often under Fireflies' 50 KB minimum.
                    "bypass_size_check": True,
                }
                if language:
                    inp["custom_language"] = language
                try:
                    # No transport retry: a dropped connection may mean Fireflies already
                    # queued the file. Treat it as uploaded so the retry only polls.
                    data = self._gql(UPLOAD, {"input": inp}, retry_transport=False)
                except httpx.TransportError:
                    api.fireflies_uploaded(reservation)
                    uploaded = True
                    raise
                out = data.get("uploadAudio") or {}
                if not out.get("success"):
                    raise FirefliesError("upload_failed", str(out.get("message") or out))
                api.fireflies_uploaded(reservation)
                uploaded = True
                log.info("fireflies upload queued", job_id=job_id, call_id=call_id)
            t = self._wait_for_transcript(title)
        except HardStop as e:
            log.error("fireflies hard stop", error=str(e))
            if not uploaded:
                api.fireflies_finalize(reservation)
            api.fireflies_block(str(e), job_id)
            raise Deferred(str(e)) from e
        except BaseException:
            # Not uploaded -> give the minutes back. Uploaded -> keep the reservation so
            # the retry only polls (never uploads, and pays, twice).
            if not uploaded:
                api.fireflies_finalize(reservation)
            raise

        duration_min = t.get("duration")
        actual = math.ceil(float(duration_min)) if duration_min else None
        api.fireflies_finalize(reservation, actual)

        sentences = sorted(t.get("sentences") or [], key=lambda s: s.get("index") or 0)
        segments = []
        for s in sentences:
            seg = {"start": _num(s.get("start_time")), "end": _num(s.get("end_time")),
                   "text": str(s.get("text") or "").strip()}
            if s.get("speaker_name"):
                seg["speaker"] = str(s["speaker_name"])
            segments.append(seg)
        text = "\n".join(s["text"] for s in segments if s["text"])

        if r.get("deleteAfterFetch", True):
            try:
                self._gql(DELETE, {"id": t["id"]}, max_tries=3)
            except Exception as e:  # noqa: BLE001 - transcript is saved; deletion is best effort
                log.warning("fireflies delete failed", transcript_id=t["id"], error=str(e))
        return Transcript(text=text, provider=self.name, language=language, segments=segments)

    def sweep_leftovers(self, api: Api, min_age_s: float = 3600) -> int:
        """Delete our uploads (title uic-<callId>) that a failed delete left in Fireflies.
        Only ones older than min_age_s whose transcript is already saved on our server,
        so a job still waiting for Fireflies is never affected. Returns how many were deleted."""
        to_date = (datetime.now(UTC) - timedelta(seconds=min_age_s)).isoformat().replace("+00:00", "Z")
        found: list[dict] = []
        for page in range(20):  # at most 1000 per sweep; the next sweep picks up the rest
            batch = self._gql(LEFTOVERS, {"toDate": to_date, "skip": page * 50}).get("transcripts") or []
            found += batch
            if len(batch) < 50:
                break
        deleted = 0
        for t in found:
            m = OUR_TITLE.match(t.get("title") or "")
            if not m or not api.has_transcript(m.group(1)):
                continue
            try:
                self._gql(DELETE, {"id": t["id"]}, max_tries=3)
                deleted += 1
            except FirefliesError as e:
                if e.code != "object_not_found":  # already gone; search can list deleted ones for a while
                    log.warning("fireflies sweep delete failed", transcript_id=t["id"], error=str(e))
            except Exception as e:  # noqa: BLE001 - try again next sweep
                log.warning("fireflies sweep delete failed", transcript_id=t["id"], error=str(e))
        return deleted

    def _wait_for_transcript(self, title: str) -> dict:
        start = time.monotonic()
        deadline = start + self.max_wait_s
        waited = 0.0
        since = (datetime.now(UTC) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
        delay = 15.0
        transcript_id: str | None = None
        while True:
            if transcript_id is None:
                found = self._gql(FIND, {"keyword": title, "fromDate": since}).get("transcripts") or []
                transcript_id = next((x["id"] for x in found if x.get("title") == title), None)
            if transcript_id is not None:
                t = self._gql(GET, {"id": transcript_id}).get("transcript") or {}
                silent = (t.get("meeting_info") or {}).get("silent_meeting")
                if t.get("sentences") or silent:
                    return t
            # Counts slept time as well as the clock, so a stubbed sleep still ends the loop.
            if max(time.monotonic(), start + waited) + delay > deadline:
                raise TimeoutError(f"Fireflies transcript for {title} not ready after {self.max_wait_s:.0f}s")
            self.sleep(delay)
            waited += delay
            delay = min(delay * 1.5, 60.0)


def _code(e: dict) -> str | None:
    return e.get("code") or (e.get("extensions") or {}).get("code")


def _retry_after(res: httpx.Response, errors: list[dict]) -> float:
    """Seconds to wait: Retry-After header (seconds or HTTP date), else metadata.retryAfter (epoch ms)."""
    h = res.headers.get("retry-after")
    wait: float | None = None
    if h:
        try:
            wait = float(h)
        except ValueError:
            try:
                wait = (parsedate_to_datetime(h) - datetime.now(UTC)).total_seconds()
            except (TypeError, ValueError):
                wait = None
    if wait is None:
        for e in errors:
            ms = ((e.get("extensions") or {}).get("metadata") or {}).get("retryAfter")
            if isinstance(ms, (int, float)):
                wait = ms / 1000 - time.time()
                break
    return max(1.0, min(wait if wait is not None else 60.0, 900.0))


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
