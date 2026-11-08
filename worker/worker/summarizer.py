"""AI summary jobs: the same loop as translation (live calls now, backlog in one Message Batch, heartbeats,
failure usage reported toward the Claude monthly cap), with summarize.py doing the work."""

import structlog

from .pii import mask_text
from .summarize import SummaryError, summarize_batch, summarize_call
from .translator import Translator

log = structlog.get_logger()


def summary_payload(out: dict, usage: dict, default_model: str, batch: bool, mask: bool = False) -> dict:
    if mask:
        # Admin privacy setting: Aadhaar / card numbers never reach the database, summaries included.
        out = {**out, "summary": mask_text(out["summary"]), "actionItems": [mask_text(a) for a in out["actionItems"]]}
    return {
        **out,
        "model": usage.get("model") or default_model,
        "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                  "batch": batch},
    }


class Summarizer(Translator):
    KIND = "summarize"

    @property
    def model(self) -> str:
        return self.settings.summary_model

    def translate_live(self, job: dict) -> None:
        job_id = job["jobId"]
        self._hold(job_id)
        try:
            transcript = self.api.get_transcript(job["callId"])
            out, usage = summarize_call(self.client, transcript, job.get("agentName"), self.model)
            self.api.post_summary(job_id, summary_payload(out, usage, self.model, False, bool(job.get("maskPii"))))
            log.info("summarized", job_id=job_id, call_id=job["callId"], batch=False)
        except Exception as e:  # noqa: BLE001 - reported and retried by the API
            log.exception("summarize failed", job_id=job_id)
            self._fail(job_id, e)
        finally:
            self._release(job_id)

    def translate_backlog(self, jobs: list[dict]) -> None:
        calls: dict[str, tuple[dict, str | None]] = {}
        mask = {job["jobId"]: bool(job.get("maskPii")) for job in jobs}
        for job in jobs:
            try:
                calls[job["jobId"]] = (self.api.get_transcript(job["callId"]), job.get("agentName"))
            except Exception as e:  # noqa: BLE001
                log.exception("could not fetch transcript", job_id=job["jobId"])
                self._fail(job["jobId"], e)
        if not calls:
            return
        try:
            results = summarize_batch(self.client, calls, model=self.model, poll_s=self.poll_s)
        except Exception as e:  # noqa: BLE001 - whole batch failed; every job is retried
            log.exception("summarize batch failed", jobs=len(calls))
            for job_id in calls:
                self._fail(job_id, e)
            return
        for job_id in calls:
            r = results.get(job_id, SummaryError("missing from batch results"))
            if isinstance(r, Exception):
                self._fail(job_id, r)
                continue
            out, usage = r
            try:
                self.api.post_summary(job_id, summary_payload(out, usage, self.model, True, mask[job_id]))
            except Exception:
                log.exception("could not post summary", job_id=job_id)
        log.info("summarize batch done", jobs=len(calls))
