import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    api_url: str
    worker_token: str
    worker_id: str
    provider: str
    language: str | None
    batch_size: int
    idle_max_sleep: float
    # Provider-specific
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    openai_api_key: str | None
    openai_model: str

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        token = e.get("WORKER_TOKEN", "")
        if len(token) < 32:
            raise SystemExit("WORKER_TOKEN must be set (32+ chars)")
        return cls(
            api_url=e.get("API_URL", "http://localhost:8000").rstrip("/"),
            worker_token=token,
            worker_id=e.get("WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}",
            provider=e.get("TRANSCRIBE_PROVIDER", "stub"),
            language=e.get("TRANSCRIBE_LANGUAGE") or None,
            batch_size=int(e.get("WORKER_BATCH_SIZE", "1")),
            idle_max_sleep=float(e.get("WORKER_IDLE_MAX_SLEEP", "30")),
            whisper_model=e.get("WHISPER_MODEL", "large-v3-turbo"),
            whisper_device=e.get("WHISPER_DEVICE", "auto"),
            whisper_compute_type=e.get("WHISPER_COMPUTE_TYPE", "default"),
            openai_api_key=e.get("OPENAI_API_KEY") or None,
            openai_model=e.get("OPENAI_TRANSCRIBE_MODEL", "whisper-1"),
        )
