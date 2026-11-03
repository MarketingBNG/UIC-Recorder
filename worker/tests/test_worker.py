import httpx
import respx

from worker.config import Settings
from worker.main import Api, process_job
from worker.providers.stub import StubProvider

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1"}


def test_settings_require_token():
    try:
        Settings.from_env({})
    except SystemExit:
        return
    raise AssertionError("expected SystemExit")


@respx.mock
def test_process_job_posts_transcript():
    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x" * 100))
    result = respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204))

    process_job(api, StubProvider(), {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1",
                                      "mimeType": "audio/mp4"}, None)

    body = result.calls.last.request.read()
    assert b'"ok":true' in body.replace(b" ", b"")
    assert b"100 bytes" in body
    assert result.calls.last.request.headers["authorization"] == "Bearer " + "w" * 40


@respx.mock
def test_provider_error_is_reported_as_retryable():
    class Boom:
        name = "boom"

        def transcribe(self, *_):
            raise RuntimeError("provider down")

    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x"))
    result = respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204))
    process_job(api, Boom(), {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1"}, None)
    body = result.calls.last.request.read().replace(b" ", b"")
    assert b'"ok":false' in body and b'"retryable":true' in body and b"providerdown" in body


def test_only_transient_errors_are_retried():
    from worker.main import _is_transient

    req = httpx.Request("POST", "http://x")
    assert _is_transient(httpx.ConnectError("down"))
    assert _is_transient(httpx.HTTPStatusError("", request=req, response=httpx.Response(503, request=req)))
    assert not _is_transient(httpx.HTTPStatusError("", request=req, response=httpx.Response(404, request=req)))
    assert not _is_transient(httpx.HTTPStatusError("", request=req, response=httpx.Response(413, request=req)))


@respx.mock
def test_run_loop_survives_a_failed_result_post(monkeypatch):
    import worker.main as m

    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x"))
    respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(400))
    try:
        process_job(api, StubProvider(), {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1"}, None)
    except httpx.HTTPStatusError:
        pass  # surfaces immediately (no 5-minute retry); run() catches it per job
    assert respx.calls.call_count == 2


def test_run_processes_jobs_in_parallel():
    """With concurrency=4, four slow jobs overlap instead of running one by one."""
    import threading
    import time

    import worker.main as m
    from worker.providers import Transcript

    settings = Settings.from_env({**ENV, "WORKER_CONCURRENCY": "4", "WORKER_IDLE_MAX_SLEEP": "0.05"})
    queue = [{"jobId": f"j{i}", "callId": f"c{i}", "audioPath": f"/a/{i}"} for i in range(8)]
    lock = threading.Lock()
    active = peak = 0
    finished: list[str] = []
    stop_after = threading.Event()

    class FakeApi:
        def claim(self, limit):
            with lock:
                taken = [queue.pop(0) for _ in range(min(limit, len(queue)))]
            assert limit <= 4
            return taken

        def download(self, path, dest):
            dest.write_bytes(b"x")

        def heartbeat(self, job_id):
            return True

        def post_result(self, job_id, payload):
            with lock:
                finished.append(job_id)
                if len(finished) == 8:
                    stop_after.set()

    class Slow:
        name = "slow"

        def transcribe(self, *_):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.2)
            with lock:
                active -= 1
            return Transcript(text="ok", provider="slow")

    orig_api, orig_load = m.Api, m.load_provider
    m.Api = lambda s: FakeApi()
    m.load_provider = lambda s: Slow()
    try:
        t = threading.Thread(target=m.run, args=(settings,), daemon=True)
        start = time.monotonic()
        # run() installs signal handlers, which only works on the main thread; patch them out.
        orig_signal = m.signal.signal
        m.signal.signal = lambda *a: None
        t.start()
        assert stop_after.wait(5), "jobs did not finish"
        elapsed = time.monotonic() - start
    finally:
        m.Api, m.load_provider = orig_api, orig_load
        m.signal.signal = orig_signal
    assert sorted(finished) == sorted(f"j{i}" for i in range(8))
    assert peak == 4
    assert elapsed < 1.2  # 8 jobs x 0.2s sequentially would be 1.6s+
