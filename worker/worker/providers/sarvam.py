"""Sarvam AI speech-to-text (Saaras), used as overflow when the Fireflies monthly budget runs out.

The synchronous REST endpoint is meant for clips under 30 s, so the call is cut into CHUNK_S pieces
with ffmpeg (mono 16 kHz WAV) and each piece is sent on its own; chunk-level timestamps are shifted
by the piece's offset. English comes later from the normal Claude translate job, as for Fireflies.

Not run against the paid API in tests; see tests/test_sarvam.py (mocked with respx).
"""

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

import httpx

from ..config import Settings
from . import PermanentError, Transcript

URL = "https://api.sarvam.ai/speech-to-text"
CHUNK_S = 25


def split_audio(audio: Path, out_dir: Path, chunk_s: int = CHUNK_S) -> list[Path]:
    """Cuts `audio` into mono 16 kHz WAV pieces of `chunk_s` seconds (the last one shorter)."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(audio), "-ac", "1", "-ar", "16000",
         "-f", "segment", "-segment_time", str(chunk_s), "-reset_timestamps", "1", str(out_dir / "part%04d.wav")],
        check=True, capture_output=True, timeout=600,
    )
    return sorted(out_dir.glob("part*.wav"))


class SarvamProvider:
    name = "sarvam"

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None,
                 splitter: Callable[[Path, Path], list[Path]] | None = None) -> None:
        if not settings.sarvam_api_key:
            raise SystemExit("SARVAM_API_KEY is required for TRANSCRIBE_PROVIDER=sarvam")
        if splitter is None and shutil.which("ffmpeg") is None:
            raise SystemExit("TRANSCRIBE_PROVIDER=sarvam needs ffmpeg in the worker image (calls are cut into 25 s pieces)")
        self.model = settings.sarvam_model
        self.language = settings.sarvam_language
        self.split = splitter or split_audio
        self.client = httpx.Client(
            headers={"api-subscription-key": settings.sarvam_api_key},
            timeout=httpx.Timeout(120, connect=10),
            transport=transport,
        )

    def _chunk(self, part: Path, language: str) -> dict:
        data = {"model": self.model, "language_code": language, "with_timestamps": "true"}
        with part.open("rb") as f:
            res = self.client.post(URL, data=data, files={"file": (part.name, f, "audio/wav")})
        if res.status_code in (400, 401, 403, 404, 413, 415, 422):
            raise PermanentError(f"Sarvam {res.status_code}: {res.text[:300]}")
        res.raise_for_status()  # 429 / 5xx: the API retries the job with backoff
        return res.json()

    def transcribe(self, audio: Path, mime_type: str | None, language: str | None) -> Transcript:
        lang = language if language and "-" in language else self.language
        segments: list[dict] = []
        texts: list[str] = []
        detected: dict[str, int] = {}
        with tempfile.TemporaryDirectory(prefix="uic-sarvam-") as tmp:
            parts = self.split(audio, Path(tmp))
            if not parts:
                raise PermanentError("ffmpeg produced no audio")
            for i, part in enumerate(parts):
                body = self._chunk(part, lang)
                offset = i * CHUNK_S
                text = str(body.get("transcript") or "").strip()
                if text:
                    texts.append(text)
                if code := body.get("language_code"):
                    detected[code] = detected.get(code, 0) + 1
                ts = body.get("timestamps") or {}
                words = ts.get("words") or []
                starts = ts.get("start_time_seconds") or []
                ends = ts.get("end_time_seconds") or []
                # One segment per chunk (the translator sends one line per segment); word times, when
                # present, narrow the segment to the speech and are kept as detail.
                if not text:
                    continue
                seg: dict = {"start": offset, "end": offset + CHUNK_S, "text": text}
                if words and len(words) == len(starts) == len(ends):
                    seg["start"] = round(offset + float(starts[0]), 2)
                    seg["end"] = round(offset + float(ends[-1]), 2)
                    seg["words"] = [{"start": round(offset + float(s), 2), "end": round(offset + float(e), 2),
                                     "text": str(w).strip()} for w, s, e in zip(words, starts, ends) if str(w).strip()]
                segments.append(seg)
        language_out = max(detected, key=detected.get) if detected else None
        return Transcript(text="\n".join(texts),
                          provider=f"{self.name}:{self.model}", language=language_out, segments=segments)
