from pathlib import Path

from ..config import Settings
from . import Transcript


class FasterWhisperProvider:
    """Self-hosted Whisper. Needs the `local` extra; uses a GPU when available."""

    name = "faster_whisper"

    def __init__(self, settings: Settings) -> None:
        from faster_whisper import WhisperModel  # heavy import, only when selected

        if settings.whisper_task == "translate" and "turbo" in settings.whisper_model:
            raise SystemExit("WHISPER_TASK=translate needs WHISPER_MODEL=large-v3 (turbo can't translate)")
        self.task = settings.whisper_task

        self.model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
            # One shared model; lets WORKER_CONCURRENCY jobs decode at the same time.
            num_workers=settings.concurrency,
        )
        self.model_name = settings.whisper_model

    def transcribe(self, audio: Path, mime_type: str | None, language: str | None) -> Transcript:
        # vad_filter runs Silero VAD to skip silence, ringing and hold music.
        segments, info = self.model.transcribe(
            str(audio),
            language=language,
            task=self.task,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
        return Transcript(
            text=" ".join(s["text"] for s in segs).strip(),
            provider=f"{self.name}:{self.model_name}",
            language=info.language,
            segments=segs,
        )
