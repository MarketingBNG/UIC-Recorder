from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from ..config import Settings


@dataclass
class Transcript:
    text: str
    provider: str
    language: str | None = None
    segments: list[dict] = field(default_factory=list)


class PermanentError(Exception):
    """Failure that retrying won't fix (bad config, unsupported audio)."""


class Deferred(Exception):
    """The API already put the job back (budget, batch gate, hard stop); post no result."""


class Provider(Protocol):
    name: str

    def transcribe(self, audio: Path, mime_type: str | None, language: str | None) -> Transcript: ...


def load_provider(settings: Settings) -> Provider:
    match settings.provider:
        case "stub":
            from .stub import StubProvider

            return StubProvider()
        case "faster_whisper":
            from .faster_whisper import FasterWhisperProvider

            return FasterWhisperProvider(settings)
        case "openai":
            from .openai import OpenAIProvider

            return OpenAIProvider(settings)
        case "fireflies":
            from .fireflies import FirefliesProvider

            return FirefliesProvider(settings)
        case "sarvam":
            from .sarvam import SarvamProvider

            return SarvamProvider(settings)
        case other:
            raise SystemExit(f"Unknown TRANSCRIBE_PROVIDER: {other}")
