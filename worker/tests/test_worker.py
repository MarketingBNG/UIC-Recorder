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
