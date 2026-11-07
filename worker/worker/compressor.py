"""Compress jobs (Milestone 2b): re-encode a transcribed call's stored audio to small AAC.

Runs in its own loop, one job at a time, so it never takes a transcription slot. Same settings the phones
use for uploads (mono, 16 kHz, 24 kbps AAC in .m4a). The new file is only uploaded when its duration is
within 1 s of the original's and it is smaller; on any failure the server keeps the original.
"""

import hashlib
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

import httpx
import structlog

from .providers import PermanentError

log = structlog.get_logger()

FFMPEG_ARGS = ["-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "24k"]
MAX_DURATION_DIFF_S = 1.0
FFMPEG_TIMEOUT_S = 3600


class CompressError(PermanentError):
    """The re-encoded file is unusable (bad duration, not smaller): keep the original, don't retry."""


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def probe_duration(path: Path, run=subprocess.run) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
              capture_output=True, text=True, timeout=300, check=True)
    try:
        return float(out.stdout.strip())
    except ValueError as e:
        raise CompressError(f"ffprobe gave no duration for {path.name}") from e


def encode(src: Path, dest: Path, run=subprocess.run) -> None:
    run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vn", *FFMPEG_ARGS,
         "-movflags", "+faststart", str(dest)], capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S, check=True)


def compress_file(src: Path, dest: Path, run=subprocess.run) -> tuple[int, int]:
    """Re-encodes src to dest and checks it. Returns (old bytes, new bytes); raises CompressError if unusable."""
    try:
        old_s = probe_duration(src, run)
        encode(src, dest, run)
        new_s = probe_duration(dest, run)
    except subprocess.CalledProcessError as e:
        # A file ffmpeg can't read won't get better on retry.
        raise CompressError(f"{e.cmd[0]} failed: {(e.stderr or '').strip()[:500]}") from e
    if abs(new_s - old_s) > MAX_DURATION_DIFF_S:
        raise CompressError(f"duration changed: {old_s:.1f}s -> {new_s:.1f}s")
    old_b, new_b = src.stat().st_size, dest.stat().st_size
    if new_b >= old_b:
        raise CompressError(f"not smaller: {old_b} -> {new_b} bytes")
    return old_b, new_b


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def process_compress(api, job: dict, run=subprocess.run) -> None:
    """One compress job: download, re-encode, check, upload. Failures are reported; the original stays."""
    job_id = job["jobId"]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="uic-c-") as tmp:
        src, dest = Path(tmp) / "original.bin", Path(tmp) / "compressed.m4a"
        try:
            api.download(job["audioPath"], src)
            old_b, new_b = compress_file(src, dest, run)
            api.put_compressed(job["callId"], job_id, dest, sha256_file(dest))
        except CompressError as e:
            log.warning("compression skipped; original kept", job_id=job_id, call_id=job["callId"], reason=str(e))
            api.post_result(job_id, {"ok": False, "error": f"compress: {e}"[:2000], "retryable": False})
            return
        except httpx.HTTPStatusError as e:
            # 4xx: the server refused the swap (call changed, not smaller, lock lost); retrying won't help.
            retryable = e.response.status_code >= 500 or e.response.status_code == 429
            log.warning("compressed audio not stored; original kept", job_id=job_id, status=e.response.status_code,
                        reason=e.response.text[:200])
            api.post_result(job_id, {"ok": False, "error": f"compress: HTTP {e.response.status_code}: "
                                     f"{e.response.text[:500]}", "retryable": retryable})
            return
        except Exception as e:  # noqa: BLE001 - reported and retried by the API; original kept
            log.exception("compression failed; original kept", job_id=job_id)
            api.post_result(job_id, {"ok": False, "error": f"compress: {type(e).__name__}: {e}"[:2000],
                                     "retryable": True})
            return
    log.info("recording compressed", job_id=job_id, call_id=job["callId"], old_bytes=old_b, new_bytes=new_b,
             seconds=round(time.monotonic() - started, 1))


class Compressor:
    def __init__(self, api, idle_max_sleep: float, stopping: Callable[[], bool] = lambda: False) -> None:
        self.api, self.idle_max_sleep, self.stopping = api, idle_max_sleep, stopping
        self._thread: threading.Thread | None = None

    @classmethod
    def start(cls, api, idle_max_sleep: float, stopping: Callable[[], bool]) -> "Compressor":
        c = cls(api, idle_max_sleep, stopping)
        c._thread = threading.Thread(target=c.run, name="compress", daemon=True)
        c._thread.start()
        return c

    def join(self) -> None:
        if self._thread:
            self._thread.join()

    def tick(self) -> int:
        try:
            jobs = self.api.claim(1, ("compress",))
        except Exception:
            log.exception("compress claim failed")
            return 0
        for job in jobs:
            try:
                from .main import _Heartbeat

                with _Heartbeat(self.api, job["jobId"]):
                    process_compress(self.api, job)
            except Exception:
                log.exception("could not finish compress job", job_id=job.get("jobId"))
        return len(jobs)

    def run(self) -> None:
        idle = 1.0
        while not self.stopping():
            if self.tick():
                idle = 1.0
            else:
                time.sleep(idle)
                # Compression is never urgent: poll slowly when there is nothing to do.
                idle = min(idle * 2, max(self.idle_max_sleep, 60))
