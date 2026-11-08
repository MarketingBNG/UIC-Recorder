import json
from types import SimpleNamespace

import httpx
import pytest
import respx

from worker.config import Settings
from worker.main import Api
from worker.summarize import (MAX_CHARS, SCHEMA, SummaryError, parse_reply, request_params, summarize_batch,
                              summarize_call, transcript_lines)
from worker.summarizer import Summarizer, summary_payload

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1", "ANTHROPIC_API_KEY": "k",
       "TRANSLATE_BATCH_MAX": "2"}

GOOD = {"summary": "Client asked about GST.", "actionItems": ["Send GSTR-3B", " "], "sentiment": "positive",
        "tags": ["GST"], "speakerRoles": [{"speaker": "Ravi", "role": "Agent"}, {"speaker": "Ghost", "role": "Agent"}]}

TRANSCRIPT = {"text": "namaste\nhaan", "textEn": "hello\nyes", "segments": [
    {"text": "namaste", "en": "hello", "speaker": "Ravi"},
    {"text": "haan", "en": "yes", "speaker": "Speaker 2"},
]}


def reply(d, stop="end_turn"):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(d) if isinstance(d, dict) else d)],
                           stop_reason=stop, usage=SimpleNamespace(input_tokens=100, output_tokens=20))


class FakeMessages:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def create(self, **kw):
        self.calls.append(kw)
        return self.replies.pop(0)


def client(*replies, batches=None):
    c = SimpleNamespace(messages=FakeMessages(replies))
    c.messages.batches = batches
    return c


def test_transcript_lines_prefers_english_and_lists_speakers():
    lines, speakers = transcript_lines(TRANSCRIPT)
    assert lines == ["Ravi: hello", "Speaker 2: yes"]
    assert speakers == ["Ravi", "Speaker 2"]
    lines, speakers = transcript_lines({"text": "a\n\nb"})
    assert lines == ["a", "b"] and speakers == []


def test_request_params_structured_output_and_cut():
    p = request_params("claude-sonnet-5-5", ["x" * (MAX_CHARS + 10)], "Ravi")
    assert p["output_config"]["format"]["schema"] is SCHEMA
    assert p["thinking"] == {"type": "between_tools"}
    content = p["messages"][0]["content"]
    assert "staff member on this call is: Ravi" in content and "cut here" in content
    assert "thinking" not in request_params("claude-opus-5-5", ["x"], None)


def test_parse_reply_cleans_roles_and_lists():
    out = parse_reply(reply(GOOD), ["Ravi", "Speaker 2"])
    assert out["actionItems"] == ["Send GSTR-3B"]
    # Unknown speaker names dropped; every real speaker gets a role.
    assert out["speakerRoles"] == [{"speaker": "Ravi", "role": "Agent"}, {"speaker": "Speaker 2", "role": "Unknown"}]
    assert parse_reply(reply({**GOOD, "sentiment": "angry"}), [])["sentiment"] == "neutral"
    with pytest.raises(SummaryError):
        parse_reply(reply(GOOD, stop="max_tokens"), [])
    with pytest.raises(SummaryError):
        parse_reply(reply("not json"), [])
    with pytest.raises(SummaryError):
        parse_reply(reply({**GOOD, "summary": "  "}), [])


def test_summarize_call_retries_once_and_reports_usage_on_failure():
    c = client(reply("oops"), reply(GOOD))
    out, usage = summarize_call(c, TRANSCRIPT, "Ravi")
    assert out["summary"] == GOOD["summary"]
    assert usage == {"model": "claude-sonnet-5-5", "input_tokens": 200, "output_tokens": 40}

    c = client(reply("bad"), reply("bad"))
    with pytest.raises(SummaryError) as e:
        summarize_call(c, TRANSCRIPT)
    assert e.value.usage["input_tokens"] == 200
    with pytest.raises(SummaryError):
        summarize_call(client(), {"text": ""})


class FakeBatches:
    def __init__(self, fail=()):
        self.fail, self.created = set(fail), []

    def create(self, requests):
        self.created.append(requests)
        return SimpleNamespace(id="b1")

    def retrieve(self, _id):
        return SimpleNamespace(id="b1", processing_status="ended")

    def results(self, _id):
        for req in self.created[-1]:
            cid = req["custom_id"]
            kind = "errored" if cid in self.fail else "succeeded"
            yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type=kind, message=reply(GOOD)))


def test_summarize_batch():
    b = FakeBatches(fail={"j2"})
    res = summarize_batch(client(batches=b), {"j1": (TRANSCRIPT, "Ravi"), "j2": (TRANSCRIPT, None),
                                               "j3": ({"text": ""}, None)}, poll_s=0)
    assert len(b.created[0]) == 2
    assert res["j1"][0]["summary"] == GOOD["summary"]
    assert isinstance(res["j2"], SummaryError) and isinstance(res["j3"], SummaryError)


def test_summary_payload_masks_pii():
    out = parse_reply(reply({**GOOD, "summary": "Aadhaar 2341 2341 2346 noted", "actionItems": ["Verify 2341 2341 2346"]}), [])
    p = summary_payload(out, {"model": "m", "input_tokens": 1, "output_tokens": 2}, "d", True, mask=True)
    assert "2341 2341 2346" not in p["summary"] and "2341 2341 2346" not in p["actionItems"][0]
    assert p["usage"] == {"inputTokens": 1, "outputTokens": 2, "batch": True}
    assert p["model"] == "m"


class FakeApi:
    def __init__(self, jobs):
        self.jobs, self.claims, self.summaries, self.results = list(jobs), [], {}, {}

    def claim(self, limit, kinds=("transcribe",)):
        self.claims.append(tuple(kinds))
        taken, self.jobs = self.jobs[:limit], self.jobs[limit:]
        return taken

    def get_transcript(self, call_id):
        return TRANSCRIPT

    def post_summary(self, job_id, payload):
        self.summaries[job_id] = payload

    def post_result(self, job_id, payload):
        self.results[job_id] = payload

    def heartbeat(self, job_id):
        return True


def test_summarizer_claims_summarize_jobs_and_posts_live_results():
    settings = Settings.from_env({**ENV, "SUMMARY_MODEL": "claude-sonnet-5-5"})
    api = FakeApi([{"jobId": "j1", "callId": "c1", "priority": 10, "agentName": "Ravi"}])
    s = Summarizer(api, client(reply(GOOD)), settings)
    assert s.tick() == 1
    assert api.claims[0] == ("summarize",)
    assert api.summaries["j1"]["sentiment"] == "positive"
    assert "Ravi" in s.client.messages.calls[0]["messages"][0]["content"]


def test_summarizer_failure_reports_usage():
    settings = Settings.from_env(ENV)
    api = FakeApi([{"jobId": "j1", "callId": "c1", "priority": 10}])
    Summarizer(api, client(reply("x"), reply("x")), settings).tick()
    r = api.results["j1"]
    assert r["ok"] is False and r["model"] == "claude-sonnet-5-5"
    assert r["usage"]["inputTokens"] == 200


def test_settings_summary_defaults():
    s = Settings.from_env({"WORKER_TOKEN": "w" * 40})
    assert s.summary_model == "claude-sonnet-5-5" and s.summarize_enabled
    assert not Settings.from_env({"WORKER_TOKEN": "w" * 40, "SUMMARIZE_ENABLED": "false"}).summarize_enabled


@respx.mock
def test_api_post_summary_ignores_lost_lock():
    api = Api(Settings.from_env(ENV))
    route = respx.post("http://api.test/internal/jobs/j1/summary").mock(return_value=httpx.Response(409))
    api.post_summary("j1", {"summary": "x"})
    assert json.loads(route.calls[0].request.content)["workerId"] == "t1"
