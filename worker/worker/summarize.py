"""AI call summary with Claude: summary, action items, sentiment, tags, and which speaker is the staff member.

Reads the English text (each segment's `en`, else its original text) with speaker names when the transcript
has them (Fireflies). Structured output (JSON schema) like translate.py; Sonnet by default (SUMMARY_MODEL).
`summarize_batch` uses the Message Batches API (50% off) for backlog calls.
"""

import json
import time

from .translate import SONNET

SENTIMENTS = ("positive", "neutral", "negative", "mixed")
ROLES = ("Agent", "Customer", "Unknown")
# Long calls are cut here (about 50k tokens) so one call can't run away with the monthly cap.
MAX_CHARS = 200_000
MAX_ITEMS, MAX_TAGS = 20, 8

PROMPT = """You summarise phone calls between staff of USA India CFO (an Indian accounting / CFO services firm)
and the people they call (clients, prospects, vendors). The transcript is below, one line per utterance,
"speaker: text" when speakers are known. The staff member on this call is: {agent}.

Return:
- summary: 2-5 plain sentences: who called whom, why, what was agreed.
- actionItems: concrete follow-ups ("Send GSTR-3B draft to client by Friday"); empty list if none.
- sentiment: the customer's overall sentiment: positive, neutral, negative or mixed.
- tags: up to 8 short topic tags (e.g. GST, TDS, ITR, payroll, invoice, payment follow-up, onboarding).
- speakerRoles: for every distinct speaker name in the transcript, "Agent" if it is the staff member
  (the firm's side), "Customer" if it is the other party, "Unknown" if you can't tell. Empty list when the
  lines have no speaker names.
Keep names, amounts and tax terms exactly. Write in English.

Transcript:
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "actionItems": {"type": "array", "items": {"type": "string"}},
        "sentiment": {"type": "string", "enum": list(SENTIMENTS)},
        "tags": {"type": "array", "items": {"type": "string"}},
        "speakerRoles": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"speaker": {"type": "string"}, "role": {"type": "string", "enum": list(ROLES)}},
                "required": ["speaker", "role"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "actionItems", "sentiment", "tags", "speakerRoles"],
    "additionalProperties": False,
}


class SummaryError(Exception):
    """`usage` (when set) is what Claude charged for the failed attempts, reported so the monthly cap counts it."""
    usage: dict | None = None


def transcript_lines(transcript: dict) -> tuple[list[str], list[str]]:
    """("speaker: text" lines, distinct speaker names in order). English where a translation exists."""
    segs = transcript.get("segments") or []
    if not segs:
        text = transcript.get("textEn") or transcript.get("text") or ""
        return [ln.strip() for ln in text.splitlines() if ln.strip()], []
    lines, speakers = [], []
    for s in segs:
        text = " ".join(str(s.get("en") or s.get("text") or "").split())
        if not text:
            continue
        sp = str(s.get("speaker") or "").strip()
        if sp and sp not in speakers:
            speakers.append(sp)
        lines.append(f"{sp}: {text}" if sp else text)
    return lines, speakers


def request_params(model: str, lines: list[str], agent: str | None) -> dict:
    body = "\n".join(lines)
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS] + "\n[transcript cut here: too long]"
    params = {
        "model": model,
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": PROMPT.format(agent=agent or "not known") + body}],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    }
    if model.startswith("claude-sonnet"):
        params["thinking"] = {"type": "between_tools"}
    return params


def _clean_list(v, limit: int, width: int) -> list[str]:
    out = [" ".join(str(x).split())[:width] for x in (v or []) if str(x).strip()]
    return out[:limit]


def parse_reply(msg, speakers: list[str]) -> dict:
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise SummaryError(f"stop_reason={msg.stop_reason}")
    text = next(b.text for b in msg.content if b.type == "text")
    try:
        d = json.loads(text)
        summary = str(d["summary"]).strip()
    except (ValueError, KeyError, TypeError) as e:
        raise SummaryError(f"bad summary reply: {e}") from e
    if not summary:
        raise SummaryError("empty summary")
    sentiment = d.get("sentiment") if d.get("sentiment") in SENTIMENTS else "neutral"
    # Only speakers that are really in the transcript, each once; missing ones are Unknown.
    roles = {}
    for r in d.get("speakerRoles") or []:
        sp, role = str(r.get("speaker", "")).strip(), r.get("role")
        if sp in speakers and sp not in roles:
            roles[sp] = role if role in ROLES else "Unknown"
    return {
        "summary": summary[:20_000],
        "actionItems": _clean_list(d.get("actionItems"), MAX_ITEMS, 2000),
        "sentiment": sentiment,
        "tags": _clean_list(d.get("tags"), MAX_TAGS, 100),
        "speakerRoles": [{"speaker": sp, "role": roles.get(sp, "Unknown")} for sp in speakers],
    }


def _usage(msg, model: str) -> dict:
    return {"model": model, "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}


def summarize_call(client, transcript: dict, agent: str | None = None, model: str = SONNET) -> tuple[dict, dict]:
    """Live calls: one request now (one retry on a bad reply). Returns (summary dict, usage)."""
    lines, speakers = transcript_lines(transcript)
    if not lines:
        raise SummaryError("empty transcript")
    tried, err = [], None
    for _ in range(2):
        msg = client.messages.create(**request_params(model, lines, agent))
        tried.append(_usage(msg, model))
        try:
            out = parse_reply(msg, speakers)
        except SummaryError as e:
            err = e
            continue
        return out, {"model": model, "input_tokens": sum(u["input_tokens"] for u in tried),
                     "output_tokens": sum(u["output_tokens"] for u in tried)}
    err.usage = {"model": model, "input_tokens": sum(u["input_tokens"] for u in tried),
                 "output_tokens": sum(u["output_tokens"] for u in tried)}
    raise err


def summarize_batch(client, calls: dict[str, tuple[dict, str | None]], model: str = SONNET, poll_s: int = 30) -> dict:
    """Backlog: one Message Batch. `calls` is {id: (transcript, agent)}. Returns {id: (summary, usage) | Exception}."""
    results: dict = {}
    todo = {}
    for cid, (transcript, agent) in calls.items():
        lines, speakers = transcript_lines(transcript)
        if lines:
            todo[cid] = (lines, speakers, agent)
        else:
            results[cid] = SummaryError("empty transcript")
    if not todo:
        return results
    batch = client.messages.batches.create(requests=[
        {"custom_id": cid, "params": request_params(model, lines, agent)} for cid, (lines, _, agent) in todo.items()
    ])
    while (batch := client.messages.batches.retrieve(batch.id)).processing_status != "ended":
        time.sleep(poll_s)
    for r in client.messages.batches.results(batch.id):
        if r.custom_id not in todo:
            continue
        _, speakers, agent = todo[r.custom_id]
        if r.result.type != "succeeded":
            results[r.custom_id] = SummaryError(f"batch result {r.result.type}")
            continue
        msg = r.result.message
        try:
            results[r.custom_id] = (parse_reply(msg, speakers), _usage(msg, model))
        except SummaryError:
            # Rare: redo this one call live.
            try:
                results[r.custom_id] = summarize_call(client, calls[r.custom_id][0], agent, model)
            except Exception as e:  # noqa: BLE001 - fails only this call
                results[r.custom_id] = e
    return results
