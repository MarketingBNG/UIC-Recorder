import json

import httpx
import respx

from worker.config import Settings
from worker.main import Api, process_job
from worker.providers.fireflies import URL, FirefliesProvider

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1",
       "TRANSCRIBE_PROVIDER": "fireflies", "FIREFLIES_API_KEY": "ff-key", "FIREFLIES_MAX_WAIT_S": "600"}
JOB = {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1", "mimeType": "audio/mp4"}
TRANSCRIPT = {
    "id": "t-1", "title": "uic-c1", "duration": 2.4,
    "meeting_info": {"silent_meeting": False, "summary_status": "processed"},
    "sentences": [
        {"index": 1, "speaker_name": "Agent", "text": "World", "start_time": 3.5, "end_time": 4.0},
        {"index": 0, "speaker_name": "Client", "text": "Hello", "start_time": 0.2, "end_time": 1.1},
    ],
}


def make(sleeps: list[float] | None = None):
    s = Settings.from_env(ENV)
    rec = sleeps if sleeps is not None else []
    return Api(s), FirefliesProvider(s, sleep=rec.append)


def mock_api(reserve: dict | None = None):
    r = reserve or {"status": "reserved", "reservationId": "r1", "minutes": 3, "uploaded": False,
                    "transcriptId": None, "deleteAfterFetch": True}
    routes = {
        "reserve": respx.post("http://api.test/internal/fireflies/jobs/j1/reserve").mock(return_value=httpx.Response(200, json=r)),
        "url": respx.get("http://api.test/internal/fireflies/audio-url/c1").mock(
            return_value=httpx.Response(200, json={"url": "https://calls.example/public/audio/c1.m4a?exp=1&sig=x"})),
        "uploaded": respx.post("http://api.test/internal/fireflies/reservations/r1/uploaded").mock(return_value=httpx.Response(204)),
        "finalize": respx.post("http://api.test/internal/fireflies/reservations/r1/finalize").mock(return_value=httpx.Response(204)),
        "block": respx.post("http://api.test/internal/fireflies/block").mock(return_value=httpx.Response(200, json={})),
        "result": respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204)),
    }
    return routes


def graphql(handlers):
    """Routes Fireflies GraphQL calls by operation to a list of queued responses."""
    seen: list[dict] = []

    def respond(request: httpx.Request):
        body = json.loads(request.content)
        seen.append(body)
        assert request.headers["authorization"] == "Bearer ff-key"
        for key, queue in handlers.items():
            if key in body["query"]:
                return queue.pop(0) if len(queue) > 1 else queue[0]
        raise AssertionError(body["query"])

    respx.post(URL).mock(side_effect=respond)
    return seen


ok = lambda data: httpx.Response(200, json={"data": data})  # noqa: E731


@respx.mock
def test_happy_path_maps_segments_and_deletes():
    api, ff = make()
    routes = mock_api()
    seen = graphql({
        "uploadAudio": [ok({"uploadAudio": {"success": True, "title": "uic-c1", "message": "queued"}})],
        "transcripts(": [ok({"transcripts": []}), ok({"transcripts": [{"id": "t-1", "title": "uic-c1"}]})],
        "transcript(id": [ok({"transcript": TRANSCRIPT})],
        "deleteTranscript": [ok({"deleteTranscript": {"id": "t-1"}})],
    })
    process_job(api, ff, JOB, None)

    upload = next(b for b in seen if "uploadAudio" in b["query"])["variables"]["input"]
    assert upload["url"].startswith("https://") and upload["title"] == "uic-c1" and upload["client_reference_id"] == "c1"
    assert any("deleteTranscript" in b["query"] for b in seen)
    assert routes["uploaded"].called
    assert json.loads(routes["finalize"].calls.last.request.content) == {"actualMinutes": 3}
    body = json.loads(routes["result"].calls.last.request.content)
    assert body["ok"] is True and body["provider"] == "fireflies"
    assert body["text"] == "Hello\nWorld"
    assert body["segments"][0] == {"start": 0.2, "end": 1.1, "text": "Hello", "speaker": "Client"}


@respx.mock
def test_rate_limit_respects_retry_after():
    sleeps: list[float] = []
    api, ff = make(sleeps)
    mock_api({"status": "reserved", "reservationId": "r1", "minutes": 3, "uploaded": False, "deleteAfterFetch": False})
    seen = graphql({
        "uploadAudio": [
            httpx.Response(429, headers={"Retry-After": "7"},
                           json={"errors": [{"message": "slow down", "code": "too_many_requests"}]}),
            ok({"uploadAudio": {"success": True}}),
        ],
        "transcripts(": [ok({"transcripts": [{"id": "t-1", "title": "uic-c1"}]})],
        "transcript(id": [ok({"transcript": TRANSCRIPT})],
    })
    process_job(api, ff, JOB, None)
    assert sleeps[0] == 7.0
    assert sum("uploadAudio" in b["query"] for b in seen) == 2
    assert not any("deleteTranscript" in b["query"] for b in seen)  # deleteAfterFetch false


@respx.mock
def test_unsupported_format_is_permanent_and_never_reaches_fireflies():
    api, ff = make()
    routes = mock_api()
    ff_route = respx.post(URL).mock(return_value=httpx.Response(500))
    process_job(api, ff, {**JOB, "mimeType": "audio/amr"}, None)
    body = json.loads(routes["result"].calls.last.request.content)
    assert body["ok"] is False and body["retryable"] is False and body["error"].startswith("UNSUPPORTED_FORMAT")
    assert not ff_route.called and not routes["reserve"].called


@respx.mock
def test_quota_error_triggers_hard_stop_and_no_result():
    sleeps: list[float] = []
    api, ff = make(sleeps)
    routes = mock_api()
    graphql({"uploadAudio": [httpx.Response(200, json={"errors": [
        {"message": "Upgrade required", "code": "paid_required", "extensions": {"code": "paid_required", "status": 403}}]})]})
    process_job(api, ff, JOB, None)
    block = json.loads(routes["block"].calls.last.request.content)
    assert block["jobId"] == "j1" and "paid_required" in block["error"]
    assert routes["finalize"].called  # not uploaded -> minutes released
    assert not routes["result"].called  # the API already deferred the job
    assert sleeps == []  # no retry loop


@respx.mock
def test_budget_refusal_posts_nothing():
    api, ff = make()
    routes = mock_api({"status": "refused", "reason": "BUDGET", "retryAt": "2026-12-01T00:00:00Z", "message": "full"})
    ff_route = respx.post(URL).mock(return_value=httpx.Response(500))
    process_job(api, ff, JOB, None)
    assert not ff_route.called and not routes["result"].called


@respx.mock
def test_retry_after_upload_only_polls():
    api, ff = make()
    routes = mock_api({"status": "reserved", "reservationId": "r1", "minutes": 3, "uploaded": True, "deleteAfterFetch": True})
    seen = graphql({
        "transcripts(": [ok({"transcripts": [{"id": "t-1", "title": "uic-c1"}]})],
        "transcript(id": [ok({"transcript": TRANSCRIPT})],
        "deleteTranscript": [ok({"deleteTranscript": {"id": "t-1"}})],
    })
    process_job(api, ff, JOB, None)
    assert not any("uploadAudio" in b["query"] for b in seen)
    assert not routes["url"].called
    assert json.loads(routes["result"].calls.last.request.content)["ok"] is True


@respx.mock
def test_poll_timeout_is_retryable_and_keeps_reservation():
    api, ff = make()
    routes = mock_api()
    graphql({
        "uploadAudio": [ok({"uploadAudio": {"success": True}})],
        "transcripts(": [ok({"transcripts": []})],
    })
    process_job(api, ff, JOB, None)
    body = json.loads(routes["result"].calls.last.request.content)
    assert body["ok"] is False and body["retryable"] is True and "TimeoutError" in body["error"]
    assert not routes["finalize"].called  # uploaded: retry polls instead of uploading again
