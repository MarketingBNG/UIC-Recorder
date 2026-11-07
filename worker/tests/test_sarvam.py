import json
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx

from worker.config import Settings
from worker.evalscore import cer, judge_translation, normalize, wer
from worker.main import Api
from worker.providers import PermanentError
from worker.providers.sarvam import CHUNK_S, URL, SarvamProvider

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_transcripts  # noqa: E402

ENV = {"WORKER_TOKEN": "t" * 32, "API_URL": "http://api.test", "SARVAM_API_KEY": "sk-test", "TRANSCRIBE_PROVIDER": "sarvam"}


def fake_split(n: int):
    def split(audio: Path, out: Path) -> list[Path]:
        parts = []
        for i in range(n):
            p = out / f"part{i:04d}.wav"
            p.write_bytes(b"RIFF")
            parts.append(p)
        return parts
    return split


def provider(n=2):
    return SarvamProvider(Settings.from_env(ENV), splitter=fake_split(n))


def test_requires_key():
    with pytest.raises(SystemExit):
        SarvamProvider(Settings.from_env({**ENV, "SARVAM_API_KEY": ""}), splitter=fake_split(1))


@respx.mock
def test_transcribe_chunks_and_offsets_timestamps(tmp_path):
    bodies = [
        {"transcript": "namaste ji. GST file ho gaya?", "language_code": "hi-IN",
         "timestamps": {"words": ["namaste ji.", "GST file ho gaya?"], "start_time_seconds": [0.0, 2.5],
                        "end_time_seconds": [2.0, 6.0]}},
        {"transcript": "haan kal bhej dunga", "language_code": "hi-IN"},
    ]
    route = respx.post(URL).mock(side_effect=[httpx.Response(200, json=b) for b in bodies])
    t = provider(2).transcribe(tmp_path / "a.m4a", "audio/mp4", None)
    assert route.call_count == 2
    req = route.calls[0].request
    assert req.headers["api-subscription-key"] == "sk-test"
    assert b'name="model"' in req.content and b"saaras:v3" in req.content
    assert t.provider == "sarvam:saaras:v3"
    assert t.language == "hi-IN"
    assert t.segments == [
        {"start": 0.0, "end": 2.0, "text": "namaste ji."},
        {"start": 2.5, "end": 6.0, "text": "GST file ho gaya?"},
        {"start": CHUNK_S, "end": 2 * CHUNK_S, "text": "haan kal bhej dunga"},
    ]
    assert t.text.splitlines()[-1] == "haan kal bhej dunga"


@respx.mock
def test_auth_error_is_permanent_and_5xx_is_retryable(tmp_path):
    respx.post(URL).mock(return_value=httpx.Response(403, json={"error": "bad key"}))
    with pytest.raises(PermanentError):
        provider(1).transcribe(tmp_path / "a.m4a", None, None)
    respx.post(URL).mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        provider(1).transcribe(tmp_path / "a.m4a", None, None)


@respx.mock
def test_claim_sends_provider():
    claim = respx.post("http://api.test/internal/jobs/claim").mock(return_value=httpx.Response(200, json={"jobs": []}))
    Api(Settings.from_env(ENV)).claim(2)
    assert json.loads(claim.calls.last.request.read())["provider"] == "sarvam"


def test_wer_and_cer():
    assert normalize("Haan, GST file ho  gaya!") == "haan gst file ho gaya"
    assert wer("haan gst file ho gaya", "Haan, GST file ho gaya.") == 0
    assert wer("a b c d", "a x c") == 0.5  # one substitution + one deletion
    assert wer("", "") == 0 and wer("", "x") == 1
    assert cer("abcd", "abxd") == 0.25
    assert wer("नमस्ते जी", "नमस्ते जी") == 0


def test_judge_parses_structured_reply():
    reply = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(
        type="text", text=json.dumps({"accuracy": 5, "terms": 4, "fluency": 3, "notes": "ok"}))])
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: reply))
    assert judge_translation(client, "ref", "cand")["mean"] == 4.0
    refused = SimpleNamespace(stop_reason="refusal", content=[])
    with pytest.raises(ValueError):
        judge_translation(SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: refused)), "r", "c")


def test_eval_scores_cached_providers(tmp_path):
    refs, out = tmp_path / "refs", tmp_path / "out"
    refs.mkdir()
    out.mkdir()
    (refs / "c1.json").write_text(json.dumps({"audio": "c1.m4a", "text": "haan gst file ho gaya", "en": "Yes, GST is filed",
                                              "fireflies": {"text": "haan gst file gaya", "en": "Yes GST filed"}}))
    (out / "c1.sarvam.json").write_text(json.dumps({"text": "haan gst file ho gaya"}))
    judge = lambda r, c: {"mean": 5.0 if c == "Yes GST filed" else 1.0}  # noqa: E731
    result = eval_transcripts.score(eval_transcripts.load_refs(refs), out, judge)
    assert result["summary"]["sarvam"]["wer"] == 0
    assert result["summary"]["sarvam"]["judge"] is None  # no English from Sarvam
    assert result["summary"]["fireflies"]["wer"] == 0.2
    assert result["summary"]["fireflies"]["judge"] == 5.0
