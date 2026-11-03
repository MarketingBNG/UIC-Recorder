from pathlib import Path

from . import Transcript


class StubProvider:
    """For testing the pipeline end to end without paying for transcription."""

    name = "stub"

    def transcribe(self, audio: Path, mime_type: str | None, language: str | None) -> Transcript:
        size = audio.stat().st_size
        return Transcript(
            text=f"[stub transcript] {size} bytes of {mime_type or 'audio'}",
            provider=self.name,
            language=language or "en",
            segments=[{"start": 0.0, "end": 0.0, "text": "stub"}],
        )
