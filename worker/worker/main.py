import signal
import tempfile
import time
from pathlib import Path

import httpx
import structlog
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import Settings
from .providers import PermanentError, Provider, load_provider

log = structlog.get_logger()

_EXT = {"audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/aac": ".aac", "audio/amr": ".amr",
        "audio/3gpp": ".3gp", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/wav": ".wav",
        "audio/webm": ".webm"}

_network_retry = retry(
    retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
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
    def claim(self, limit: int) -> list[dict]:
        res = self.http.post("/internal/jobs/claim", json={"workerId": self.worker_id, "limit": limit})
        res.raise_for_status()
        return res.json()["jobs"]

    @_network_retry
    def download(self, audio_path: str, dest: Path) -> None:
        with self.http.stream("GET", audio_path) as res:
            res.raise_for_status()
            with dest.open("wb") as f:
                for chunk in res.iter_bytes(1 << 16):
                    f.write(chunk)

    @_network_retry
    def post_result(self, job_id: str, payload: dict) -> None:
        res = self.http.post(f"/internal/jobs/{job_id}/result", json={"workerId": self.worker_id, **payload})
        if res.status_code == 409:
            log.warning("lost job lock; result discarded", job_id=job_id)
            return
        res.raise_for_status()


def process_job(api: Api, provider: Provider, job: dict, language: str | None) -> None:
    job_id = job["jobId"]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="uic-") as tmp:
        audio = Path(tmp) / f"audio{_EXT.get(job.get('mimeType') or '', '.bin')}"
        try:
            api.download(job["audioPath"], audio)
            t = provider.transcribe(audio, job.get("mimeType"), language)
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
        log.info("stopping after current job")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("worker started", worker_id=settings.worker_id, provider=provider.name, api=settings.api_url)

    idle = 1.0
    while not stopping:
        try:
            jobs = api.claim(settings.batch_size)
        except Exception:
            log.exception("claim failed")
            jobs = []
        if not jobs:
            time.sleep(idle)
            idle = min(idle * 2, settings.idle_max_sleep)
            continue
        idle = 1.0
        for job in jobs:
            process_job(api, provider, job, settings.language)


def main() -> None:
    structlog.configure(processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ])
    run(Settings.from_env())
