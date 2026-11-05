import json
import threading
import time
from types import SimpleNamespace

import httpx
import respx

import worker.translator as tr
from worker.config import Settings
from worker.main import Api
from worker.translator import Translator, segments_of

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1"}
KEYED = {**ENV, "ANTHROPIC_API_KEY": "k", "TRANSLATE_BATCH_MAX": "2", "TRANSLATE_BATCH_WAIT_S": "900"}


def reply(lines):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps({"en": lines}))],
                           stop_reason="end_turn", usage=SimpleNamespace(input_tokens=10, output_tokens=5))


class FakeMessages:
    def __init__(self, lines):
        self.lines, self.calls = lines, []

    def create(self, **kw):
        self.calls.append(kw)
        return reply(self.lines)


class FakeBatches:
    def __init__(self, results, polls=0, fail_ids=()):
        self.lines, self.polls, self.fail_ids, self.created = results, polls, set(fail_ids), []

    def create(self, requests):
        self.created.append(requests)
        return SimpleNamespace(id="b1")

    def retrieve(self, _id):
        self.polls -= 1
        return SimpleNamespace(id="b1", processing_status="ended" if self.polls < 0 else "in_progress")

    def results(self, _id):
        for req in self.created[-1]:
            cid = req["custom_id"]
            if cid in self.fail_ids:
                yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="errored"))
            else:
                yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="succeeded", message=reply(self.lines[cid])))


class FakeClient:
    def __init__(self, lines=None, batches=None):
        self.messages = FakeMessages(lines or [])
        self.messages.batches = batches


class FakeApi:
    def __init__(self, jobs, transcripts):
        self.jobs, self.transcripts = list(jobs), transcripts
        self.claims, self.translations, self.results, self.beats = [], {}, {}, []

    def claim(self, limit, kinds=("transcribe",)):
        self.claims.append((limit, tuple(kinds)))
        taken, self.jobs = self.jobs[:limit], self.jobs[limit:]
        return taken

    def get_transcript(self, call_id):
        return self.transcripts[call_id]

    def post_translation(self, job_id, payload):
        self.translations[job_id] = payload

    def post_result(self, job_id, payload):
        self.results[job_id] = payload

    def heartbeat(self, job_id):
        self.beats.append(job_id)
        return True


def test_settings_defaults():
    s = Settings.from_env(ENV)
    assert s.anthropic_api_key is None and s.translate_model == "claude-opus-5-5"
    assert s.translate_batch_max == 100 and s.translate_batch_wait_s == 900


def test_segments_fall_back_to_text_lines():
    assert segments_of({"text": "a\n\nb", "segments": []}) == [{"text": "a"}, {"text": "b"}]
    assert segments_of({"text": "x", "segments": [{"text": "y"}]}) == [{"text": "y"}]


@respx.mock
def test_live_job_translated_and_posted():
    settings = Settings.from_env(KEYED)
    api = Api(settings)
    claim = respx.post("http://api.test/internal/jobs/claim").mock(return_value=httpx.Response(200, json={"jobs": [
        {"jobId": "j1", "callId": "c1", "kind": "translate", "priority": 10}]}))
    respx.get("http://api.test/internal/transcripts/c1").mock(return_value=httpx.Response(200, json={
        "callId": "c1", "text": "नमस्ते\nOkay send it", "language": "hi",
        "segments": [{"start": 0, "text": "नमस्ते"}, {"start": 1, "text": "Okay send it"}]}))
    posted = respx.post("http://api.test/internal/jobs/j1/translation").mock(return_value=httpx.Response(204))
    client = FakeClient(["Hello"])

    assert Translator(api, client, settings).tick() == 1

    assert json.loads(claim.calls.last.request.read())["kinds"] == ["translate"]
    body = json.loads(posted.calls.last.request.read())
    assert body["workerId"] == "t1" and body["model"] == "claude-opus-5-5"
    assert body["textEn"] == "Hello\nOkay send it"
    assert [s["en"] for s in body["segments"]] == ["Hello", "Okay send it"]
    assert body["segments"][0]["start"] == 0
    assert body["usage"] == {"inputTokens": 10, "outputTokens": 5, "batch": False}
    assert client.messages.calls[0]["model"] == "claude-opus-5-5"


def test_live_failure_posts_retryable_error():
    api = FakeApi([{"jobId": "j1", "callId": "c1", "priority": 10}], {})  # transcript missing -> KeyError
    Translator(api, FakeClient(), Settings.from_env(KEYED)).tick()
    assert api.results["j1"]["ok"] is False and api.results["j1"]["retryable"] is True
    assert not api.translations


def test_backlog_jobs_go_in_one_batch_with_forced_model():
    jobs = [{"jobId": "j1", "callId": "c1", "priority": 0}, {"jobId": "j2", "callId": "c2", "priority": 0}]
    transcripts = {"c1": {"text": "नमस्ते", "segments": []}, "c2": {"text": "", "segments": [{"text": "kya hai"}]}}
    api = FakeApi(jobs, transcripts)
    batches = FakeBatches({"j1": ["Hello"], "j2": ["What is it"]})
    t = Translator(api, FakeClient(batches=batches), Settings.from_env(KEYED), poll_s=0)
    t.tick()
    t.batch_thread.join(5)

    assert len(batches.created) == 1 and len(batches.created[0]) == 2
    assert all(r["params"]["model"] == "claude-opus-5-5" for r in batches.created[0])
    assert api.translations["j1"]["textEn"] == "Hello"
    assert api.translations["j2"]["textEn"] == "What is it"
    assert api.translations["j1"]["usage"]["batch"] is True
    assert not t.held


def test_backlog_waits_until_timeout_then_failed_call_is_retried():
    now = [0.0]
    jobs = [{"jobId": "j1", "callId": "c1"}, {"jobId": "j2", "callId": "c2"}]
    transcripts = {"c1": {"text": "नमस्ते"}, "c2": {"text": "शुक्रिया"}}
    settings = Settings.from_env({**KEYED, "TRANSLATE_BATCH_MAX": "5", "TRANSLATE_BATCH_WAIT_S": "60"})
    api = FakeApi(jobs, transcripts)
    batches = FakeBatches({"j1": ["Hello"]}, fail_ids={"j2"})
    t = Translator(api, FakeClient(batches=batches), settings, clock=lambda: now[0], poll_s=0)
    t.tick()
    assert t.batch_thread is None and len(t.pending) == 2  # not full, not waited long enough
    now[0] = 61
    t.tick()
    t.batch_thread.join(5)
    assert api.translations["j1"]["textEn"] == "Hello"
    assert api.results["j2"]["ok"] is False and api.results["j2"]["retryable"] is True


def test_heartbeat_covers_jobs_while_batch_runs(monkeypatch):
    monkeypatch.setattr(tr, "HEARTBEAT_SECONDS", 0.01)
    jobs = [{"jobId": "j1", "callId": "c1"}, {"jobId": "j2", "callId": "c2"}]
    transcripts = {"c1": {"text": "नमस्ते"}, "c2": {"text": "शुक्रिया"}}
    api = FakeApi(jobs, transcripts)
    batches = FakeBatches({"j1": ["Hello"], "j2": ["Thanks"]}, polls=20)
    stop = threading.Event()
    t = Translator(api, FakeClient(batches=batches), Settings.from_env(KEYED), stopping=stop.is_set, poll_s=0.01)
    runner = threading.Thread(target=t.run, daemon=True)
    runner.start()
    deadline = time.monotonic() + 5
    while len(api.translations) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    stop.set()
    runner.join(5)
    assert set(api.translations) == {"j1", "j2"}
    assert "j1" in api.beats and "j2" in api.beats


def _run_worker_once(env):
    import worker.main as m

    claims = []
    started = threading.Event()

    class Api_:
        def claim(self, limit, kinds=("transcribe",)):
            claims.append(tuple(kinds))
            started.set()
            return []

        def heartbeat(self, job_id):
            return True

    orig = (m.Api, m.load_provider, m.signal.signal)
    m.Api = lambda s: Api_()
    m.load_provider = lambda s: SimpleNamespace(name="stub")
    handlers = {}
    m.signal.signal = lambda sig, h: handlers.__setitem__(sig, h)
    import anthropic
    orig_anthropic = anthropic.Anthropic
    anthropic.Anthropic = lambda **kw: SimpleNamespace()
    try:
        t = threading.Thread(target=m.run, args=(Settings.from_env(env),), daemon=True)
        t.start()
        started.wait(2)
        time.sleep(0.2)
        handlers[m.signal.SIGTERM]()
        t.join(5)
    finally:
        m.Api, m.load_provider, m.signal.signal = orig
        anthropic.Anthropic = orig_anthropic
    return claims


def test_translate_jobs_claimed_only_with_api_key():
    env = {**ENV, "WORKER_IDLE_MAX_SLEEP": "0.05"}
    assert ("translate",) not in _run_worker_once(env)
    assert ("translate",) in _run_worker_once({**env, "ANTHROPIC_API_KEY": "k"})


def test_live_retry_api_error_does_not_sink_rest_of_batch():
    jobs = [{"jobId": "j1", "callId": "c1"}, {"jobId": "j2", "callId": "c2"}]
    transcripts = {"c1": {"text": "नमस्ते"}, "c2": {"text": "शुक्रिया\nफिर मिलेंगे"}}
    api = FakeApi(jobs, transcripts)
    batches = FakeBatches({"j1": ["Hello"], "j2": ["Thanks"]})  # j2 drops a line -> live retry

    class Boom(FakeMessages):
        def create(self, **kw):
            raise ConnectionError("network down")

    client = FakeClient(batches=batches)
    client.messages = Boom([])
    client.messages.batches = batches
    t = Translator(api, client, Settings.from_env(KEYED), poll_s=0)
    t.tick()
    t.batch_thread.join(5)
    assert api.translations["j1"]["textEn"] == "Hello"
    assert api.results["j2"]["ok"] is False and api.results["j2"]["retryable"] is True


def test_shutdown_hands_back_pending_jobs():
    stop = threading.Event()
    api = FakeApi([{"jobId": "j1", "callId": "c1"}], {"c1": {"text": "नमस्ते"}})
    settings = Settings.from_env({**KEYED, "TRANSLATE_BATCH_MAX": "5"})
    t = Translator(api, FakeClient(batches=FakeBatches({})), settings, stopping=stop.is_set)
    t.tick()
    assert len(t.pending) == 1
    stop.set()
    t.run()
    assert api.results["j1"]["ok"] is False and api.results["j1"]["retryable"] is True
    assert not t.pending and not t.held


def test_lost_lock_drops_job_from_pending_and_heartbeats():
    api = FakeApi([{"jobId": "j1", "callId": "c1"}, {"jobId": "j2", "callId": "c2"}], {})
    api.heartbeat = lambda job_id: job_id != "j1"
    settings = Settings.from_env({**KEYED, "TRANSLATE_BATCH_MAX": "5"})
    t = Translator(api, FakeClient(), settings)
    t.tick()
    t.beat_once()
    assert [j["jobId"] for j in t.pending] == ["j2"]
    assert t.held == {"j2"}


def test_claim_never_asks_for_more_than_server_limit():
    # The API rejects limit > 20 with 400; a batch of 100 fills over several claims.
    api = FakeApi([], {})
    Translator(api, FakeClient(), Settings.from_env(KEYED)).tick()
    assert api.claims and all(limit <= 20 for limit, _ in api.claims)
