"""Strict, fail-closed JSON loading and canonical JSON output.

Inputs are parsed with hooks that reject floats (money and counts must be
integers), non-finite constants, duplicate object keys and oversized integer
literals. Errors carry codes only; parser messages that could quote input text
are discarded.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, Tuple

from .errors import InputRejected, Issue

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_INT_DIGITS = 15


class _Reject(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _reject_float(_literal: str) -> Any:
    raise _Reject("FLOAT_NOT_ALLOWED")


def _reject_constant(_literal: str) -> Any:
    raise _Reject("NON_FINITE_NUMBER")


def _bounded_int(literal: str) -> int:
    if len(literal.lstrip("-")) > MAX_INT_DIGITS:
        raise _Reject("INTEGER_OUT_OF_RANGE")
    return int(literal)


def _unique_object(pairs: Iterable[Tuple[str, Any]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise _Reject("DUPLICATE_KEY")
        obj[key] = value
    return obj


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_strict_json(data: bytes, max_bytes: int = MAX_INPUT_BYTES) -> Any:
    if len(data) > max_bytes:
        raise InputRejected([Issue("INPUT_TOO_LARGE")])
    if data.startswith(b"\xef\xbb\xbf"):
        raise InputRejected([Issue("ENCODING_INVALID")])
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise InputRejected([Issue("ENCODING_INVALID")]) from None
    try:
        return json.loads(
            text,
            parse_float=_reject_float,
            parse_int=_bounded_int,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except _Reject as exc:
        raise InputRejected([Issue(exc.code)]) from None
    except RecursionError:
        raise InputRejected([Issue("JSON_TOO_DEEP")]) from None
    except ValueError:
        raise InputRejected([Issue("JSON_INVALID")]) from None
