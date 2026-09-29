"""Versioned, closed JSON input schemas with explicit allowlists.

Every object is closed: unknown keys are rejected (with a PII-aware category
code), every required key must be present and every value must match its
field rule. There are no free-text fields anywhere. Header values that later
fields depend on (business, currency, ref key id) are only used once they have
themselves validated.

Schema-level checks stop at the document boundary; cross-row and date-range
checks (duplicates, conflicts, coverage) live in ``evidence``.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional, Tuple

from .errors import Issue
from .identifiers import forbidden_key_code, forbidden_value_code
from .naming import (
    campaign_issues,
    content_issues,
    conversion_ref_issues,
    experiment_id_issues,
    landing_path_issues,
)
from .vocab import (
    APP_OUTCOMES,
    BUSINESSES,
    CAMPAIGN_SENTINELS,
    CLASSIFICATIONS,
    CONTENT_SENTINELS,
    CURRENCIES,
    DATA_ORIGINS,
    DECISIONS,
    EXPERIMENT_REGISTRY,
    EXPERIMENT_STATUSES,
    GA4_BEHAVIOR,
    LANDING_PATH_SENTINELS,
    MEDIUMS,
    OUTCOME_TYPES,
    PAYMENT_EVENTS,
    PAYMENT_LEDGER,
    PRIMARY_OUTCOMES,
    SCHEMA_KINDS,
    SOURCES,
    SUPPORTED_SCHEMA_VERSION,
    TIMEZONES,
)

MAX_ROWS = 250_000
MAX_RANGES = 400
MAX_EXPERIMENTS = 500
MAX_ISSUES = 50
MAX_COUNT = 1_000_000_000
MAX_AMOUNT_MINOR = 1_000_000_000
MAX_BUDGET_MINOR = 1_000_000_000_000
MAX_EVENT_SEQ = 1_000

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_KEY_ID = re.compile(r"k\d{2}")
_REGISTRY_EXCLUDED = ("not_set", "other")

Check = Callable[[Any, str, "_Collector"], None]


class _Collector:
    def __init__(self) -> None:
        self.issues: List[Issue] = []
        self._truncated = False

    def add(self, code: str, path: str) -> None:
        issue = Issue(code, path)
        if issue in self.issues or self._truncated:
            return
        if len(self.issues) >= MAX_ISSUES:
            self.issues.append(Issue("TOO_MANY_ISSUES", "$"))
            self._truncated = True
            return
        self.issues.append(issue)

    def count(self) -> int:
        return len(self.issues)


# ── Field rules ───────────────────────────────────────────────────────────────
def _string(value: Any, path: str, out: _Collector, detect: bool = True) -> bool:
    if not isinstance(value, str):
        out.add("TYPE_STRING", path)
        return False
    if detect:
        code = forbidden_value_code(value)
        if code is not None:
            out.add("FORBIDDEN_VALUE:" + code, path)
            return False
    return True


def _enum(values) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        if _string(value, path, out) and value not in values:
            out.add("INVALID_ENUM", path)

    return check


def _integer(low: int, high: int) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        if type(value) is not int:
            out.add("TYPE_INTEGER", path)
        elif not low <= value <= high:
            out.add("INTEGER_OUT_OF_RANGE", path)

    return check


def _boolean(value: Any, path: str, out: _Collector) -> None:
    if type(value) is not bool:
        out.add("TYPE_BOOLEAN", path)


def parse_date(value: str) -> Optional[date]:
    if not _DATE.fullmatch(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_timestamp(value: str) -> Optional[datetime]:
    if not _TIMESTAMP.fullmatch(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def _date(value: Any, path: str, out: _Collector) -> None:
    if _string(value, path, out, detect=False) and parse_date(value) is None:
        out.add("INVALID_DATE", path)


def _timestamp(value: Any, path: str, out: _Collector) -> None:
    if _string(value, path, out, detect=False) and parse_timestamp(value) is None:
        out.add("INVALID_TIMESTAMP", path)


def _named(rule: Callable[[str], List[str]], sentinels=()) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        if not isinstance(value, str):
            out.add("TYPE_STRING", path)
            return
        if value in sentinels:
            return
        for code in rule(value):
            out.add(code, path)

    return check


def _campaign(business: Optional[str], sentinels=CAMPAIGN_SENTINELS) -> Check:
    return _named(lambda name: campaign_issues(name, business), sentinels)


def _ref(key_id: Optional[str]) -> Check:
    return _named(lambda value: conversion_ref_issues(value, key_id))


def _key_id(value: Any, path: str, out: _Collector) -> None:
    if _string(value, path, out) and not _KEY_ID.fullmatch(value):
        out.add("INVALID_KEY_ID", path)


def _object(fields: Dict[str, Check]) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        if not isinstance(value, dict):
            out.add("TYPE_OBJECT", path)
            return
        for key in value:
            if key not in fields:
                out.add(forbidden_key_code(key), path)
        for key, rule in fields.items():
            if key not in value:
                out.add("MISSING_KEY:" + key, path)
            else:
                rule(value[key], path + "." + key, out)

    return check


def _array(item: Check, limit: Callable[[], int]) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        if not isinstance(value, list):
            out.add("TYPE_ARRAY", path)
            return
        if len(value) > limit():
            out.add("TOO_MANY_ITEMS", path)
            return
        for index, element in enumerate(value):
            if out.count() > MAX_ISSUES:
                return
            item(element, "{}[{}]".format(path, index), out)

    return check


def _primary_outcome(value: Any, path: str, out: _Collector) -> None:
    if isinstance(value, list):
        out.add("MULTIPLE_PRIMARY_OUTCOMES", path)
        return
    _enum(PRIMARY_OUTCOMES)(value, path, out)


def _row_currency(header_currency: Optional[str]) -> Check:
    def check(value: Any, path: str, out: _Collector) -> None:
        before = out.count()
        _enum(tuple(CURRENCIES))(value, path, out)
        if out.count() == before and header_currency is not None and value != header_currency:
            out.add("MIXED_CURRENCY", path)

    return check


# ── Documents ─────────────────────────────────────────────────────────────────
_RANGE = _object({"start": _date, "end": _date})
_COMMON_HEADER = {
    "schema": lambda value, path, out: None,  # already dispatched on
    "schema_version": lambda value, path, out: None,
    "data_origin": _enum(DATA_ORIGINS),
    "business": _enum(BUSINESSES),
    "timezone": _enum(TIMEZONES),
    "generated_at": _timestamp,
    "coverage": _RANGE,
    "attested_complete_ranges": _array(_RANGE, lambda: MAX_RANGES),
}


def _validated(doc: dict, key: str, rule: Check) -> Optional[str]:
    """Return ``doc[key]`` if it passes ``rule`` on its own, else None."""
    probe = _Collector()
    if key in doc:
        rule(doc[key], "$", probe)
        if not probe.issues:
            return doc[key]
    return None


def _dimension_fields(business: Optional[str]) -> Dict[str, Check]:
    return {
        "source": _enum(SOURCES),
        "medium": _enum(MEDIUMS),
        "campaign": _campaign(business),
        "content": _named(content_issues, CONTENT_SENTINELS),
        "landing_path": _named(landing_path_issues, LANDING_PATH_SENTINELS),
    }


def _ga4_behavior(doc: dict, out: _Collector) -> None:
    business = _validated(doc, "business", _enum(BUSINESSES))
    row = _object({
        "date": _date,
        **_dimension_fields(business),
        "sessions": _integer(0, MAX_COUNT),
        "checkout_starts": _integer(0, MAX_COUNT),
        "purchase_events": _integer(0, MAX_COUNT),
    })
    _object({
        **_COMMON_HEADER,
        "quality": _object({"sampled": _boolean, "thresholded": _boolean, "other_row": _boolean}),
        "rows": _array(row, lambda: MAX_ROWS),
    })(doc, "$", out)


def _payment_ledger(doc: dict, out: _Collector) -> None:
    currency = _validated(doc, "currency", _enum(tuple(CURRENCIES)))
    key_id = _validated(doc, "conversion_ref_key_id", _key_id)
    row = _object({
        "conversion_ref": _ref(key_id),
        "event": _enum(PAYMENT_EVENTS),
        "event_seq": _integer(1, MAX_EVENT_SEQ),
        "date": _date,
        "amount_minor": _integer(1, MAX_AMOUNT_MINOR),
        "currency": _row_currency(currency),
        "classification": _enum(CLASSIFICATIONS),
    })
    _object({
        **_COMMON_HEADER,
        "currency": _enum(tuple(CURRENCIES)),
        "conversion_ref_key_id": _key_id,
        "rows": _array(row, lambda: MAX_ROWS),
    })(doc, "$", out)


def _app_outcomes(doc: dict, out: _Collector) -> None:
    business = _validated(doc, "business", _enum(BUSINESSES))
    key_id = _validated(doc, "conversion_ref_key_id", _key_id)
    row = _object({
        "conversion_ref": _ref(key_id),
        "outcome": _enum(OUTCOME_TYPES),
        "date": _date,
        **_dimension_fields(business),
        "classification": _enum(CLASSIFICATIONS),
    })
    _object({
        **_COMMON_HEADER,
        "conversion_ref_key_id": _key_id,
        "rows": _array(row, lambda: MAX_ROWS),
    })(doc, "$", out)


def _experiment(value: Any, path: str, out: _Collector) -> None:
    business = _validated(value, "business", _enum(BUSINESSES)) if isinstance(value, dict) else None
    _object({
        "experiment_id": _named(lambda eid: experiment_id_issues(eid, business)),
        "business": _enum(BUSINESSES),
        "status": _enum(EXPERIMENT_STATUSES),
        "start_date": _date,
        "end_date": _date,
        "source": _enum(tuple(s for s in SOURCES if s not in _REGISTRY_EXCLUDED)),
        "medium": _enum(tuple(m for m in MEDIUMS if m not in _REGISTRY_EXCLUDED)),
        "campaign": _campaign(business, sentinels=()),
        "content": _named(content_issues, ("none",)),
        "landing_path": _named(landing_path_issues),
        "budget": _object({"amount_minor": _integer(0, MAX_BUDGET_MINOR), "currency": _enum(tuple(CURRENCIES))}),
        "primary_outcome": _primary_outcome,
        "evidence_threshold": _object({
            "min_denominator": _integer(1, MAX_COUNT),
            "min_events": _integer(1, MAX_COUNT),
        }),
        "decision": _enum(DECISIONS),
    })(value, path, out)


def _experiment_registry(doc: dict, out: _Collector) -> None:
    _object({
        "schema": _COMMON_HEADER["schema"],
        "schema_version": _COMMON_HEADER["schema_version"],
        "data_origin": _enum(DATA_ORIGINS),
        "experiments": _array(_experiment, lambda: MAX_EXPERIMENTS),
    })(doc, "$", out)


_VALIDATORS: Dict[str, Callable[[dict, _Collector], None]] = {
    GA4_BEHAVIOR: _ga4_behavior,
    PAYMENT_LEDGER: _payment_ledger,
    APP_OUTCOMES: _app_outcomes,
    EXPERIMENT_REGISTRY: _experiment_registry,
}


def validate_document(doc: Any) -> Tuple[Optional[str], List[Issue]]:
    """Return ``(kind, issues)``; ``kind`` is None when the schema is unknown."""
    if not isinstance(doc, dict):
        return None, [Issue("TYPE_OBJECT", "$")]
    if "schema" not in doc:
        return None, [Issue("MISSING_KEY:schema", "$")]
    schema = doc["schema"]
    if not isinstance(schema, str) or schema not in SCHEMA_KINDS:
        return None, [Issue("UNKNOWN_SCHEMA", "$.schema")]
    kind = SCHEMA_KINDS[schema]
    version = doc.get("schema_version")
    if type(version) is not int or version != SUPPORTED_SCHEMA_VERSION:
        return kind, [Issue("UNSUPPORTED_SCHEMA_VERSION", "$.schema_version")]
    out = _Collector()
    _VALIDATORS[kind](doc, out)
    return kind, out.issues
