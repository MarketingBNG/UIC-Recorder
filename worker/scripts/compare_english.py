"""Side-by-side English test: Fireflies + Claude (each model) vs Whisper large-v3 translate.

uv run python scripts/compare_english.py --calls fireflies.json --audio AUDIO_DIR --out OUT_DIR [--whisper-only|--claude-only]
`fireflies.json`: [{id, dur, path, text, segments}] exported from the transcripts table.
Results are cached in OUT_DIR as JSON, so re-runs only do missing work; writes OUT_DIR/report.html.
"""

import argparse
import html
import json
import os
import time
from pathlib import Path

MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
PRICE = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2, 10), "claude-opus-5-5": (4, 20)}  # $/MTok in, out


def load_env():
    for line in Path(".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))


def cached(path: Path, fn):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    out = fn()
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def run_whisper(calls, audio_dir: Path, out: Path):
    from faster_whisper import WhisperModel

    model = WhisperModel("large-v3", device="cpu", compute_type="int8")
    for c in calls:
        def go():
            t = time.time()
            segs, info = model.transcribe(str(audio_dir / c["path"]), task="translate", vad_filter=True,
                                          beam_size=5, condition_on_previous_text=False)
            segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
            return {"segments": segs, "language": info.language, "seconds": round(time.time() - t, 1)}
        r = cached(out / f"{c['id']}.whisper.json", go)
        print("whisper", c["id"], r["language"], r["seconds"], "s", flush=True)


def run_claude(calls, out: Path):
    import anthropic

    from worker.translate import translate_segments

    client = anthropic.Anthropic()
    for c in calls:
        segs = c.get("segments") or [{"text": line} for line in c["text"].splitlines()]
        for m in MODELS:
            def go():
                t = time.time()
                en, usage = translate_segments(client, segs, model=m)
                return {"segments": en, "usage": usage, "seconds": round(time.time() - t, 1)}
            r = cached(out / f"{c['id']}.{m}.json", go)
            print(m, c["id"], r["usage"], flush=True)


def report(calls, out: Path):
    rows, cost = [], {m: 0.0 for m in MODELS}
    for c in calls:
        cols = {"Fireflies (original)": "\n".join(s.get("text", "") for s in (c.get("segments") or [])) or c["text"]}
        for m in MODELS:
            p = out / f"{c['id']}.{m}.json"
            if p.exists():
                r = json.loads(p.read_text(encoding="utf-8"))
                cols[f"Fireflies + {m}"] = "\n".join(s["en"] for s in r["segments"])
                i, o = PRICE[m]
                cost[m] += (r["usage"]["input_tokens"] * i + r["usage"]["output_tokens"] * o) / 1e6
        p = out / f"{c['id']}.whisper.json"
        if p.exists():
            r = json.loads(p.read_text(encoding="utf-8"))
            cols["Whisper large-v3 translate"] = "\n".join(s["text"] for s in r["segments"])
        cells = "".join(f"<td><b>{html.escape(k)}</b><pre>{html.escape(v)}</pre></td>" for k, v in cols.items())
        rows.append(f"<h3>Call {c['id'][-6:]} ({c['dur']} s)</h3><table><tr>{cells}</tr></table>")
    mins = sum(c["dur"] for c in calls) / 60
    summary = "".join(f"<li>{m}: ${v:.4f} for {mins:.1f} min (${v / max(mins, 1e-9):.4f}/min)</li>" for m, v in cost.items())
    (out / "report.html").write_text(
        "<!doctype html><meta charset=utf-8><title>English test</title><style>body{font-family:sans-serif;margin:16px}"
        "table{border-collapse:collapse;width:100%}td{vertical-align:top;border:1px solid #ccc;padding:6px;width:20%}"
        "pre{white-space:pre-wrap;font-size:13px}</style><h1>English output comparison</h1><ul>" + summary + "</ul>"
        + "".join(rows), encoding="utf-8")
    print("report:", out / "report.html")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--calls", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--whisper-only", action="store_true")
    ap.add_argument("--claude-only", action="store_true")
    a = ap.parse_args()
    load_env()
    calls = json.loads(Path(a.calls).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if not a.claude_only:
        run_whisper(calls, Path(a.audio), out)
    if not a.whisper_only and os.environ.get("ANTHROPIC_API_KEY"):
        run_claude(calls, out)
    report(calls, out)
