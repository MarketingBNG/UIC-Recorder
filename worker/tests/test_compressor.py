import hashlib
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx

from worker.compressor import CompressError, Compressor, compress_file, process_compress
from worker.config import Settings
from worker.main import Api

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1"}
JOB = {"jobId": "j1", "callId": "c1", "kind": "compress", "audioPath": "/internal/audio/c1"}


def fake_run(old_s=60.0, new_s=60.2, new_bytes=b"small", fail_ffmpeg=False):
    """Stands in for subprocess.run: ffprobe reports durations, ffmpeg writes the output file."""
    calls = []

    def run(cmd, **_kw):
        calls.append(cmd)
        if cmd[0] == "ffprobe":
            path = Path(cmd[-1])
            return SimpleNamespace(stdout=str(new_s if path.name.startswith("compressed") else old_s))
        if fail_ffmpeg:
            raise subprocess.CalledProcessError(1, cmd, stderr="Invalid data found")
        Path(cmd[-1]).write_bytes(new_bytes)
        return SimpleNamespace(stdout="")

    run.calls = calls
    return run


def test_compress_file_uses_phone_settings_and_checks(tmp_path):
    src, dest = tmp_path / "original.bin", tmp_path / "compressed.m4a"
    src.write_bytes(b"x" * 1000)
    run = fake_run()
    assert compress_file(src, dest, run) == (1000, 5)
    ffmpeg = next(c for c in run.calls if c[0] == "ffmpeg")
    for a, b in [("-ac", "1"), ("-ar", "16000"), ("-c:a", "aac"), ("-b:a", "24k")]:
        assert ffmpeg[ffmpeg.index(a) + 1] == b


@pytest.mark.parametrize("kw,msg", [
    ({"new_s": 58.5}, "duration changed"),
    ({"new_bytes": b"y" * 2000}, "not smaller"),
    ({"fail_ffmpeg": True}, "ffmpeg failed"),
])
def test_compress_file_rejects_bad_output(tmp_path, kw, msg):
    src = tmp_path / "original.bin"
    src.write_bytes(b"x" * 1000)
    with pytest.raises(CompressError, match=msg):
        compress_file(src, tmp_path / "compressed.m4a", fake_run(**kw))


@respx.mock
def test_process_uploads_compressed_audio_with_checksum(monkeypatch):
    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x" * 1000))
    put = respx.put("http://api.test/internal/calls/c1/audio-compressed").mock(
        return_value=httpx.Response(200, json={"oldBytes": 1000, "newBytes": 5}))
    result = respx.post("http://api.test/internal/jobs/j1/result")
    process_compress(api, JOB, fake_run())
    req = put.calls.last.request
    assert req.url.params["jobId"] == "j1" and req.url.params["workerId"] == "t1"
    assert req.headers["content-type"] == "audio/mp4"
    assert req.headers["x-content-sha256"] == hashlib.sha256(b"small").hexdigest()
    assert req.content == b"small"
    assert not result.called


@respx.mock
def test_bad_output_is_reported_and_not_uploaded():
    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x" * 1000))
    put = respx.put("http://api.test/internal/calls/c1/audio-compressed")
    result = respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204))
    process_compress(api, JOB, fake_run(new_s=10))
    assert not put.called
    import json

    body = json.loads(result.calls.last.request.content)
    assert body["ok"] is False and body["retryable"] is False and "duration changed" in body["error"]


@respx.mock
def test_server_refusal_is_reported_without_retry():
    api = Api(Settings.from_env(ENV))
    respx.get("http://api.test/internal/audio/c1").mock(return_value=httpx.Response(200, content=b"x" * 1000))
    respx.put("http://api.test/internal/calls/c1/audio-compressed").mock(
        return_value=httpx.Response(409, json={"error": "Call is not transcribed; original kept"}))
    result = respx.post("http://api.test/internal/jobs/j1/result").mock(return_value=httpx.Response(204))
    process_compress(api, JOB, fake_run())
    import json

    body = json.loads(result.calls.last.request.content)
    assert body["retryable"] is False and "409" in body["error"]


def test_tick_claims_one_compress_job_at_a_time(monkeypatch):
    import worker.compressor as c

    seen = []

    class FakeApi:
        def claim(self, limit, kinds):
            seen.append((limit, kinds))
            return [JOB] if len(seen) == 1 else []

        def heartbeat(self, job_id):
            return True

    done = []
    monkeypatch.setattr(c, "process_compress", lambda api, job: done.append(job["jobId"]))
    comp = Compressor(FakeApi(), 1)
    assert comp.tick() == 1
    assert comp.tick() == 0
    assert seen[0] == (1, ("compress",))
    assert done == ["j1"]


def test_compress_can_be_turned_off():
    assert Settings.from_env(ENV).compress_enabled is True
    assert Settings.from_env({**ENV, "COMPRESS_ENABLED": "false"}).compress_enabled is False


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed")
def test_real_ffmpeg_round_trip(tmp_path):
    src = tmp_path / "original.wav"
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-ar", "44100", "-ac", "2", str(src)], check=True)
    old_b, new_b = compress_file(src, tmp_path / "compressed.m4a")
    assert new_b < old_b / 5
