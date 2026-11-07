import json
from pathlib import Path

import httpx
import respx

from worker.config import Settings
from worker.main import Api, process_job
from worker.pii import luhn_ok, mask_segments, mask_text, verhoeff_ok
from worker.providers import Transcript
from worker.translator import translation_payload

AADHAAR = "234567890124"  # passes Verhoeff
CARD = "4111111111111111"  # Visa test number, passes Luhn


def test_checksums():
    assert verhoeff_ok(AADHAAR)
    assert not verhoeff_ok("234567890123")
    assert luhn_ok(CARD)
    assert not luhn_ok("4111111111111112")


def test_masks_aadhaar_plain_and_grouped():
    assert mask_text(f"my aadhaar is {AADHAAR} ok") == "my aadhaar is [Aadhaar XXXX XXXX 0124] ok"
    assert mask_text("2345 6789 0124.") == "[Aadhaar XXXX XXXX 0124]."
    assert mask_text("2345-6789-0124") == "[Aadhaar XXXX XXXX 0124]"


def test_masks_cards_keeping_last_four():
    assert mask_text(f"card {CARD} expiry") == "card [card XXXX 1111] expiry"
    assert mask_text("4111 1111 1111 1111") == "[card XXXX 1111]"


def test_leaves_phone_numbers_amounts_and_failing_checksums():
    # 91 + mobile number that happens to pass Verhoeff.
    assert verhoeff_ok("919876543216")
    for text in ["call 919876543216", "+919876543216", "+91 98765 43210", "98765 43210", "Rs 1,20,000",
                 "234567890123", "4111111111111112", "invoice 2026-0001", "PAN ABCDE1234F", "GST 27ABCDE1234F1Z5"]:
        assert mask_text(text) == text, text


def test_masks_segment_text_and_english_including_nested_words():
    segs = [{"start": 0, "text": f"no {AADHAAR}", "en": f"number {AADHAAR}",
             "words": [{"text": CARD, "start": 1}]}]
    out = mask_segments(segs)
    assert out[0]["text"] == "no [Aadhaar XXXX XXXX 0124]"
    assert out[0]["en"] == "number [Aadhaar XXXX XXXX 0124]"
    assert out[0]["words"][0] == {"text": "[card XXXX 1111]", "start": 1}
    assert segs[0]["text"] == f"no {AADHAAR}"  # input untouched


def test_translation_payload_masks_only_when_asked():
    segs = [{"text": "x", "en": f"card {CARD}"}]
    assert CARD in translation_payload(segs, {}, "m", False)["textEn"]
    assert translation_payload(segs, {}, "m", False, mask=True)["textEn"] == "card [card XXXX 1111]"


class _Pii:
    name = "stub"

    def transcribe(self, audio: Path, mime_type, language) -> Transcript:
        return Transcript(text=f"aadhaar {AADHAAR}", provider="stub", language="en",
                          segments=[{"start": 0.0, "end": 1.0, "text": f"aadhaar {AADHAAR}"}])


def _run(mask: bool | None) -> dict:
    api = Api(Settings.from_env({"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1"}))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x"))
    result = respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204))
    job = {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1", "mimeType": "audio/mp4"}
    if mask is not None:
        job["maskPii"] = mask
    process_job(api, _Pii(), job, None)
    return json.loads(result.calls.last.request.read())


@respx.mock
def test_process_job_masks_when_the_server_says_so():
    body = _run(True)
    assert body["text"] == "aadhaar [Aadhaar XXXX XXXX 0124]"
    assert body["segments"][0]["text"] == "aadhaar [Aadhaar XXXX XXXX 0124]"


@respx.mock
def test_process_job_keeps_text_by_default():
    assert _run(None)["text"] == f"aadhaar {AADHAAR}"
    assert _run(False)["text"] == f"aadhaar {AADHAAR}"
