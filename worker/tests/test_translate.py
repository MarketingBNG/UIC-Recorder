import json
from types import SimpleNamespace

import pytest

from worker.translate import OPUS, SONNET, TranslationError, needs_translation, pick_model, translate_segments


def reply(lines, stop="end_turn"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps({"en": lines}))],
        stop_reason=stop, usage=SimpleNamespace(input_tokens=10, output_tokens=5),
    )


class FakeClient:
    def __init__(self, lines, stop="end_turn"):
        self.lines, self.stop, self.calls = lines, stop, []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        return reply(self.lines, self.stop)


def test_only_non_english_lines_are_sent_and_timestamps_kept():
    segs = [{"start": 0, "text": "नमस्ते"}, {"start": 1, "text": "Please send the invoice."}, {"start": 2, "text": "theek hai"}]
    c = FakeClient(["Hello", "Okay"])
    out, usage = translate_segments(c, segs)
    assert [s["en"] for s in out] == ["Hello", "Please send the invoice.", "Okay"]
    assert out[2]["start"] == 2 and usage["model"] == SONNET
    sent = c.calls[0]["messages"][0]["content"]
    assert "invoice" not in sent and "0|नमस्ते" in sent and "1|theek hai" in sent
    assert c.calls[0]["thinking"] == {"type": "between_tools"}


def test_all_english_call_makes_no_request():
    c = FakeClient([])
    out, usage = translate_segments(c, [{"text": "Can you share the GST return?"}])
    assert out[0]["en"] == "Can you share the GST return?" and usage["input_tokens"] == 0 and not c.calls


def test_urdu_script_goes_to_opus_without_thinking_param():
    c = FakeClient(["So."])
    _, usage = translate_segments(c, [{"text": "تو."}])
    assert usage["model"] == OPUS and "thinking" not in c.calls[0]


def test_wrong_line_count_and_truncation_raise():
    segs = [{"text": "नमस्ते"}, {"text": "ठीक है"}]
    with pytest.raises(TranslationError):
        translate_segments(FakeClient(["Hello"]), segs)
    with pytest.raises(TranslationError):
        translate_segments(FakeClient(["a", "b"], stop="max_tokens"), segs)


@pytest.mark.parametrize("text,expected", [
    ("Okay, I will send it today.", False), ("haan ji, kal bhej dunga", True), ("", False), ("GST भरना है", True),
])
def test_needs_translation(text, expected):
    assert needs_translation(text) is expected


def test_pick_model():
    assert pick_model(["नमस्ते"]) == SONNET and pick_model(["مجھ سے"]) == OPUS


class SequenceClient:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        return self.replies.pop(0)


def test_dropped_line_retries_then_falls_back_to_opus():
    segs = [{"text": "नमस्ते"}, {"text": "ठीक है"}]
    c = SequenceClient([reply(["Hello"]), reply(["Hello"]), reply(["Hello", "Okay"])])
    out, usage = translate_segments(c, segs)
    assert [s["en"] for s in out] == ["Hello", "Okay"]
    assert [k["model"] for k in c.calls] == [SONNET, SONNET, OPUS]
    assert usage["model"] == OPUS and usage["attempts"] == 3 and usage["input_tokens"] == 30
