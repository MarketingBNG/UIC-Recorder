"""Scoring for the transcription eval (scripts/eval_transcripts.py): WER, CER and a Claude judge.

WER only means something when reference and hypothesis are in the same script: a Devanagari
reference scored against Latin-script (romanized Hinglish) output is ~100% WER whatever the
quality. CER is reported alongside for the same reason; compare providers on one script.
"""

import json
import re
import unicodedata

_PUNCT = re.compile(r"[^\w\s']", re.UNICODE)


def normalize(text: str) -> str:
    """Lower-case, NFC, punctuation removed (marks inside words kept), whitespace collapsed."""
    t = unicodedata.normalize("NFC", text).lower()
    t = _PUNCT.sub(" ", t)
    return " ".join(t.split())


def _edits(ref: list, hyp: list) -> int:
    """Levenshtein distance (substitutions + deletions + insertions), O(len(hyp)) memory."""
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str) -> float:
    ref, hyp = normalize(reference).split(), normalize(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


def cer(reference: str, hypothesis: str) -> float:
    ref, hyp = list(normalize(reference).replace(" ", "")), list(normalize(hypothesis).replace(" ", ""))
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edits(ref, hyp) / len(ref)


JUDGE_PROMPT = """You grade English translations of Indian business phone calls (Hindi/Hinglish/English).
Compare the CANDIDATE English with the REFERENCE English (checked by a person). Score 1-5 for:
- accuracy: same meaning, no invented or dropped facts;
- terms: names, numbers, amounts and tax terms (GST, TDS, PAN, ITR...) kept exactly;
- fluency: natural English.
Reply as JSON.

REFERENCE:
{reference}

CANDIDATE:
{candidate}
"""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "accuracy": {"type": "integer"},
        "terms": {"type": "integer"},
        "fluency": {"type": "integer"},
        "notes": {"type": "string"},
    },
    "required": ["accuracy", "terms", "fluency", "notes"],
    "additionalProperties": False,
}


def judge_translation(client, reference_en: str, candidate_en: str, model: str = "claude-opus-5-5") -> dict:
    """Claude scores a candidate English translation against the hand-checked reference (paid call)."""
    msg = client.messages.create(
        model=model,
        max_tokens=4000,
        messages=[{"role": "user", "content": JUDGE_PROMPT.format(reference=reference_en, candidate=candidate_en)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
    )
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise ValueError(f"judge stop_reason={msg.stop_reason}")
    text = next(b.text for b in msg.content if b.type == "text")
    out = json.loads(text)
    out["mean"] = round((out["accuracy"] + out["terms"] + out["fluency"]) / 3, 2)
    return out
