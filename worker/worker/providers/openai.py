from pathlib import Path

import httpx

from ..config import Settings
from . import PermanentError, Transcript

URL = "https://api.openai.com/v1/audio/transcriptions"


class OpenAIProvider:
    """OpenAI transcription API (called over plain HTTPS, no SDK)."""

    name = "openai"

    def __init__(self, settings: Settings) -> None:
        if not settings.openai_api_key:
            raise SystemExit("OPENAI_API_KEY is required for TRANSCRIBE_PROVIDER=openai")
        self.model = settings.openai_model
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=httpx.Timeout(600, connect=10),
        )

    def transcribe(self, audio: Path, mime_type: str | None, language: str | None) -> Transcript:
        data = {"model": self.model, "response_format": "verbose_json"}
        if language:
            data["language"] = language
        with audio.open("rb") as f:
            res = self.client.post(URL, data=data, files={"file": (audio.name, f, mime_type or "audio/mp4")})
        if res.status_code in (400, 401, 403, 404, 413, 415):
            raise PermanentError(f"OpenAI {res.status_code}: {res.text[:300]}")
        res.raise_for_status()
        body = res.json()
        segs = [
            {"start": s.get("start"), "end": s.get("end"), "text": str(s.get("text", "")).strip()}
            for s in body.get("segments") or []
        ]
        return Transcript(
            text=str(body.get("text", "")).strip(),
            provider=f"{self.name}:{self.model}",
            language=body.get("language"),
            segments=segs,
        )
