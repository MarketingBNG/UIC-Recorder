"""Masks Aadhaar and payment-card numbers in transcript text (admin setting maskPii, default off).

Only digit sequences that pass the number's checksum are masked (Verhoeff for Aadhaar, Luhn for cards),
so phone numbers, amounts and invoice numbers stay readable. PAN and GSTIN are left alone on purpose:
they are business identifiers. Numbers spoken as words ("nine eight seven...") are not caught.
"""

import re
from typing import Any

# Verhoeff tables (multiplication, permutation).
_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]


def verhoeff_ok(digits: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _D[c][_P[i % 8][int(ch)]]
    return c == 0


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


# 13-19 digits, optionally grouped with single spaces or hyphens.
_CARD = re.compile(r"(?<![\d+])\d(?:[ -]?\d){12,18}(?!\d)")
# 12 digits, first 2-9, plain or grouped 4-4-4 with the same separator.
_AADHAAR = re.compile(r"(?<![\d+])[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?!\d)")
# "+91" or "91" followed by a 10-digit Indian mobile: a phone number, not an Aadhaar.
_PHONE_91 = re.compile(r"91[6-9]\d{9}")


def _card(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    return f"[card XXXX {digits[-4:]}]" if luhn_ok(digits) else m.group(0)


def _aadhaar(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    if not verhoeff_ok(digits) or (m.group(1) == "" and _PHONE_91.fullmatch(digits)):
        return m.group(0)
    return f"[Aadhaar XXXX XXXX {digits[-4:]}]"


def mask_text(text: str) -> str:
    if not text or not any(ch.isdigit() for ch in text):
        return text
    return _AADHAAR.sub(_aadhaar, _CARD.sub(_card, text))


_TEXT_KEYS = ("text", "en")


def mask_segments(value: Any) -> Any:
    """Masks the "text" / "en" strings of provider segments (nested lists and dicts, e.g. word lists)."""
    if isinstance(value, list):
        return [mask_segments(v) for v in value]
    if isinstance(value, dict):
        return {k: (mask_text(v) if k in _TEXT_KEYS and isinstance(v, str) else mask_segments(v)) for k, v in value.items()}
    return value
