import signal
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path

import httpx
import structlog
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from .config import Settings, load_dotenv
from .providers import Deferred, PermanentError, Provider, load_provider

log = structlog.get_logger()

_EXT = {"audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/aac": ".aac", "audio/amr": ".amr",
        "audio/3gpp": ".3gp", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/wav": ".wav",
        "audio/webm": ".webm"}

HEARTBEAT_SECONDS = 60


def _is_transient(e: BaseException) -> bool:
    """Network failures and 5xx/429 are worth retrying; other 4xx never succeed."""
    if isinstance(e, httpx.TransportError):
        return True
    return isinstance(e, httpx.HTTPStatusError) and (e.response.status_code >= 500 or e.response.status_code == 429)


_network_retry = retry(
    retry=retry_if_exception(_is_transient),
    wait=wait_exponential(multiplier=1, max=60),
    stop=stop_after_attempt(8),
    reraise=True,
)


class Api:
    """The worker's only link to the system: claim jobs, fetch audio, post results."""

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        self.worker_id = settings.worker_id
        self.http = httpx.Client(
            base_url=settings.api_url,
            headers={"Authorization": f"Bearer {settings.worker_token}"},
            timeout=httpx.Timeout(120, connect=10),
            transport=transport,
        )

    @_network_retry
    def claim(self, limit: int, kinds: tuple[str, ...] = ("transcribe",)) -> list[dict]:
        res = self.http.post("/internal/jobs/claim",
                             json={"workerId": self.worker_id, "limit": limit, "kinds": list(kinds)})
        res.raise_for_status()
        return res.json()["jobs"]

    @_network_retry
    def download(self, audio_path: str, dest: Path) -> None:
        with self.http.stream("GET", audio_path) as res:
            res.raise_for_status()
            with dest.open("wb") as f:
                for chunk in res.iter_bytes(1 << 16):
                    f.write(chunk)

    def heartbeat(self, job_id: str) -> bool:
        """Refreshes our lock; False means another worker took the job over."""
        try:
            res = self.http.post(f"/internal/jobs/{job_id}/heartbeat", json={"workerId": self.worker_id})
            return res.status_code != 409
        except httpx.HTTPError:
            return True  # transient; try again next beat

    @_network_retry
    def post_result(self, job_id: str, payload: dict) -> None:
        res = self.http.post(f"/internal/jobs/{job_id}/result", json={"workerId": self.worker_id, **payload})
        if res.status_code == 409:
            log.warning("lost job lock; result discarded", job_id=job_id)
            return
        res.raise_for_status()

    # ---- Translation ----

    @_network_retry
    def get_transcript(self, call_id: str) -> dict:
        res = self.http.get(f"/internal/transcripts/{call_id}")
        res.raise_for_status()
        return res.json()

    @_network_retry
    def post_translation(self, job_id: str, payload: dict) -> None:
        res = self.http.post(f"/internal/jobs/{job_id}/translation", json={"workerId": self.worker_id, **payload})
        if res.status_code == 409:
            log.warning("lost job lock; translation discarded", job_id=job_id)
            return
        res.raise_for_status()

    # ---- Fireflies (server-side budget + signed audio URL) ----

    @_network_retry
    def fireflies_reserve(self, job_id: str) -> dict:
        res = self.http.post(f"/internal/fireflies/jobs/{job_id}/reserve", json={"workerId": self.worker_id})
        if res.status_code == 409:
            raise Deferred("lost job lock")
        res.raise_for_status()
        return res.json()

    @_network_retry
    def fireflies_audio_url(self, call_id: str) -> dict:
        res = self.http.get(f"/internal/fireflies/audio-url/{call_id}")
        res.raise_for_status()
        return res.json()

    @_network_retry
    def fireflies_uploaded(self, reservation_id: str, transcript_id: str | None = None) -> None:
        body = {"transcriptId": transcript_id} if transcript_id else {}
        res = self.http.post(f"/internal/fireflies/reservations/{reservation_id}/uploaded", json=body)
        if res.status_code != 409:
            res.raise_for_status()

    @_network_retry
    def fireflies_finalize(self, reservation_id: str, actual_minutes: int | None = None) -> None:
        body = {"actualMinutes": actual_minutes} if actual_minutes is not None else {}
        res = self.http.post(f"/internal/fireflies/reservations/{reservation_id}/finalize", json=body)
        res.raise_for_status()

    @_network_retry
    def fireflies_block(self, error: str, job_id: str | None = None) -> None:
        body: dict = {"error": error[:2000]}
        if job_id:
            body |= {"jobId": job_id, "workerId": self.worker_id}
        res = self.http.post("/internal/fireflies/block", json=body)
        res.raise_for_status()


class _Heartbeat:
    """Keeps the job lock alive while a long transcription runs."""

    def __init__(self, api: Api, job_id: str) -> None:
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(api, job_id), daemon=True)

    def _run(self, api: Api, job_id: str) -> None:
        while not self._stop.wait(HEARTBEAT_SECONDS):
            if not api.heartbeat(job_id):
                log.warning("lost job lock during transcription", job_id=job_id)
                return

    def __enter__(self) -> "_Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()


def process_job(api: Api, provider: Provider, job: dict, language: str | None) -> None:
    job_id = job["jobId"]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="uic-") as tmp, _Heartbeat(api, job_id):
        audio = Path(tmp) / f"audio{_EXT.get(job.get('mimeType') or '', '.bin')}"
        try:
            if getattr(provider, "remote", False):
                # e.g. Fireflies: fetches the audio itself from a signed URL.
                t = provider.transcribe_job(api, job, language)  # type: ignore[attr-defined]
            else:
                api.download(job["audioPath"], audio)
                t = provider.transcribe(audio, job.get("mimeType"), language)
        except Deferred as e:
            # The API already re-queued the job (budget / batch gate / hard stop).
            log.info("job deferred", job_id=job_id, reason=str(e))
            return
        except PermanentError as e:
            log.error("job failed permanently", job_id=job_id, error=str(e))
            api.post_result(job_id, {"ok": False, "error": str(e), "retryable": False})
            return
        except Exception as e:  # noqa: BLE001 - any provider error is reported and retried by the API
            log.exception("job failed", job_id=job_id)
            api.post_result(job_id, {"ok": False, "error": f"{type(e).__name__}: {e}", "retryable": True})
            return
    payload = {"ok": True, "text": t.text, "provider": t.provider, "segments": t.segments}
    if t.language:
        payload["language"] = t.language
    api.post_result(job_id, payload)
    log.info("job done", job_id=job_id, call_id=job["callId"], seconds=round(time.monotonic() - started, 1),
             chars=len(t.text))


def run(settings: Settings) -> None:
    provider = load_provider(settings)
    api = Api(settings)
    stopping = False

    def stop(*_: object) -> None:
        nonlocal stopping
        stopping = True
        log.info("stopping after running jobs finish")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker started", worker_id=settings.worker_id, provider=provider.name, api=settings.api_url,
             concurrency=settings.concurrency, translate=bool(settings.anthropic_api_key))
    translator = None
    if settings.anthropic_api_key:
        from .translator import Translator

        translator = Translator.start(api, settings, lambda: stopping)

    # Up to `concurrency` jobs run at once; we only claim as many as we have free slots,
    # so other workers can take the rest of the queue.
    running: set[Future] = set()
    idle = 1.0
    with ThreadPoolExecutor(max_workers=settings.concurrency, thread_name_prefix="job") as pool:
        while not stopping or running:
            free = settings.concurrency - len(running)
            jobs: list[dict] = []
            if free > 0 and not stopping:
                try:
                    jobs = api.claim(free)
                except Exception:
                    log.exception("claim failed")
            for job in jobs:
                running.add(pool.submit(_safe_process, api, provider, job, settings.language))
            if jobs:
                idle = 1.0
            if running:
                # Wake when any job finishes (or periodically to top up free slots).
                done, _ = wait(running, timeout=idle if not jobs else 0.5, return_when=FIRST_COMPLETED)
                running -= done
            elif not jobs:
                time.sleep(idle)
                idle = min(idle * 2, settings.idle_max_sleep)
    if translator:
        translator.join()


def _safe_process(api: Api, provider: Provider, job: dict, language: str | None) -> None:
    try:
        process_job(api, provider, job, language)
    except Exception:
        # e.g. result POST failed after retries; the API reclaims the job later.
        log.exception("could not finish job", job_id=job.get("jobId"))


def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ])
    load_dotenv()
    run(Settings.from_env())
