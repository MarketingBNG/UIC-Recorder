"""English translation jobs: their own loop, separate from the transcription slots.

Live calls (priority >= 10) are translated right away; backlog calls are collected and sent as one
Message Batch (50% off) once TRANSLATE_BATCH_MAX jobs are waiting or TRANSLATE_BATCH_WAIT_S has passed.
Every claimed job is heartbeated while it waits or while its batch runs (a batch can take hours).
"""

import threading
import time
from typing import Callable

import structlog

from .config import Settings
from .pii import mask_segments
from .translate import TranslationError, translate_batch, translate_segments

CLAIM_MAX = 20  # server limit per /internal/jobs/claim

log = structlog.get_logger()

LIVE_PRIORITY = 10
HEARTBEAT_SECONDS = 60


def segments_of(transcript: dict) -> list[dict]:
    """The transcript's segments; one segment per text line when it has none."""
    segs = transcript.get("segments") or []
    if segs:
        return segs
    return [{"text": line} for line in (transcript.get("text") or "").splitlines() if line.strip()]


def translation_payload(segments: list[dict], usage: dict, default_model: str, batch: bool, mask: bool = False) -> dict:
    if mask:
        # Claude may write a spoken number as digits, so the English side is masked too.
        segments = mask_segments(segments)
    return {
        "model": usage.get("model") or default_model,
        "textEn": "\n".join(s["en"] for s in segments),
        "segments": segments,
        "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                  "batch": batch},
    }


class Translator:
    """Claims `KIND` jobs; subclasses (the summarizer) override the work methods and the model."""

    KIND = "translate"

    @property
    def model(self) -> str:
        return self.settings.translate_model

    def __init__(self, api, client, settings: Settings, stopping: Callable[[], bool] = lambda: False,
                 clock: Callable[[], float] = time.monotonic, poll_s: float = 30) -> None:
        self.api, self.client, self.settings = api, client, settings
        self.stopping, self.clock, self.poll_s = stopping, clock, poll_s
        self.pending: list[dict] = []
        self.pending_since: float | None = None
        self.held: set[str] = set()  # job ids we keep alive with heartbeats
        self.lock = threading.Lock()
        self.batch_thread: threading.Thread | None = None
        self._beat_stop = threading.Event()
        self._thread: threading.Thread | None = None

    @classmethod
    def start(cls, api, settings: Settings, stopping: Callable[[], bool]) -> "Translator":
        import anthropic

        t = cls(api, anthropic.Anthropic(api_key=settings.anthropic_api_key), settings, stopping)
        t._thread = threading.Thread(target=t.run, name=cls.KIND, daemon=True)
        t._thread.start()
        return t

    def join(self) -> None:
        if self._thread:
            self._thread.join()

    # ---- loop ----

    def run(self) -> None:
        beat = threading.Thread(target=self._beat_loop, name=f"{self.KIND}-heartbeat", daemon=True)
        beat.start()
        idle = 1.0
        try:
            while not self.stopping() or self._batch_running():
                got = self.tick()
                if got:
                    idle = 1.0
                else:
                    time.sleep(idle)
                    idle = min(idle * 2, self.settings.idle_max_sleep)
        finally:
            self.release_pending()
            self._beat_stop.set()

    def release_pending(self) -> None:
        """Shutdown: hand back claimed jobs that never made it into a batch, so they are retried at once."""
        with self.lock:
            jobs, self.pending, self.pending_since = self.pending, [], None
        for job in jobs:
            self._release(job["jobId"])
            self._fail(job["jobId"], RuntimeError("worker shutting down before translation started"))

    def tick(self) -> int:
        """One round: claim, start a due batch, run live jobs. Returns jobs claimed."""
        jobs: list[dict] = []
        # The API hands out at most CLAIM_MAX jobs per request; bigger batches fill over several ticks.
        room = min(CLAIM_MAX, self.settings.translate_batch_max - len(self.pending))
        if not self.stopping() and room > 0:
            try:
                jobs = self.api.claim(room, (self.KIND,))
            except Exception:
                log.exception("claim failed", kind=self.KIND)
        live = []
        with self.lock:
            for job in jobs:
                if job.get("priority", 0) >= LIVE_PRIORITY:
                    live.append(job)
                else:
                    self.held.add(job["jobId"])
                    if not self.pending:
                        self.pending_since = self.clock()
                    self.pending.append(job)
        # Start a due batch before live work so live calls never delay the batch timer.
        self._maybe_start_batch()
        for job in live:
            self.translate_live(job)
        self._maybe_start_batch()
        return len(jobs)

    def _maybe_start_batch(self) -> None:
        if not self.pending or self._batch_running() or self.stopping():
            return
        full = len(self.pending) >= self.settings.translate_batch_max
        waited = self.pending_since is not None and self.clock() - self.pending_since >= self.settings.translate_batch_wait_s
        if not (full or waited):
            return
        with self.lock:
            jobs, self.pending, self.pending_since = self.pending, [], None
        if not jobs:
            return
        self.batch_thread = threading.Thread(target=self._safe_batch, args=(jobs,), name=f"{self.KIND}-batch", daemon=True)
        self.batch_thread.start()

    def _batch_running(self) -> bool:
        return self.batch_thread is not None and self.batch_thread.is_alive()

    # ---- heartbeats ----

    def _hold(self, job_id: str) -> None:
        with self.lock:
            self.held.add(job_id)

    def _release(self, job_id: str) -> None:
        with self.lock:
            self.held.discard(job_id)

    def beat_once(self) -> None:
        with self.lock:
            ids = list(self.held)
        for job_id in ids:
            if not self.api.heartbeat(job_id):
                log.warning("lost translate job lock", job_id=job_id)
                with self.lock:
                    self.held.discard(job_id)
                    self.pending = [j for j in self.pending if j["jobId"] != job_id]
                    if not self.pending:
                        self.pending_since = None

    def _beat_loop(self) -> None:
        while not self._beat_stop.wait(HEARTBEAT_SECONDS):
            self.beat_once()

    # ---- work ----

    def _fail(self, job_id: str, e: BaseException) -> None:
        payload: dict = {"ok": False, "error": f"{type(e).__name__}: {e}"[:2000], "retryable": True}
        if usage := getattr(e, "usage", None):
            # Claude already charged for these tokens; the API adds them to the monthly spend.
            payload["model"] = usage.get("model") or self.model
            payload["usage"] = {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                                "batch": False}
        try:
            self.api.post_result(job_id, payload)
        except Exception:
            log.exception("could not report failure", kind=self.KIND, job_id=job_id)

    def translate_live(self, job: dict) -> None:
        job_id = job["jobId"]
        self._hold(job_id)
        try:
            segs = segments_of(self.api.get_transcript(job["callId"]))
            out, usage = translate_segments(self.client, segs, model=self.settings.translate_model)
            self.api.post_translation(job_id, translation_payload(out, usage, self.settings.translate_model, False,
                                                                       bool(job.get("maskPii"))))
            log.info("translated", job_id=job_id, call_id=job["callId"], batch=False)
        except Exception as e:  # noqa: BLE001 - reported and retried by the API
            log.exception("translate failed", job_id=job_id)
            self._fail(job_id, e)
        finally:
            self._release(job_id)

    def _safe_batch(self, jobs: list[dict]) -> None:
        try:
            self.translate_backlog(jobs)
        except Exception:
            log.exception("batch crashed", kind=self.KIND)
        finally:
            for job in jobs:
                self._release(job["jobId"])

    def translate_backlog(self, jobs: list[dict]) -> None:
        calls: dict[str, list[dict]] = {}
        mask = {job["jobId"]: bool(job.get("maskPii")) for job in jobs}
        for job in jobs:
            try:
                calls[job["jobId"]] = segments_of(self.api.get_transcript(job["callId"]))
            except Exception as e:  # noqa: BLE001
                log.exception("could not fetch transcript", job_id=job["jobId"])
                self._fail(job["jobId"], e)
        if not calls:
            return
        try:
            results = translate_batch(self.client, calls, model=self.settings.translate_model, poll_s=self.poll_s)
        except Exception as e:  # noqa: BLE001 - whole batch failed; every job is retried
            log.exception("translate batch failed", jobs=len(calls))
            for job_id in calls:
                self._fail(job_id, e)
            return
        for job_id in calls:
            r = results.get(job_id, TranslationError("missing from batch results"))
            if isinstance(r, Exception):
                self._fail(job_id, r)
                continue
            out, usage = r
            try:
                self.api.post_translation(job_id, translation_payload(out, usage, self.settings.translate_model, True,
                                                                       mask[job_id]))
            except Exception:
                log.exception("could not post translation", job_id=job_id)
        log.info("translate batch done", jobs=len(calls))
