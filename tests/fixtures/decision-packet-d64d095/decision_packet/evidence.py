"""Evidence inputs: semantic validation, de-duplication and manifest binding.

An input becomes an ``EvidenceInput`` only after strict JSON parsing, closed
schema validation and the semantic checks here all pass. The result is bound to
the SHA-256 of the exact bytes read, its row counts, coverage window,
generation time and a computed completeness state.

Completeness is positive-evidence only: a day counts as complete when the
exporter attested it *and* the export was generated at least the evidence
class's settle lag after that day ended in the declared timezone.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Callable, Dict, FrozenSet, Hashable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from .errors import InputRejected, Issue
from .jsonio import MAX_INPUT_BYTES, parse_strict_json, sha256_hex
from .schemas import parse_date, parse_timestamp, validate_document
from .vocab import (
    APP_OUTCOMES,
    CLASSIFICATIONS,
    EXPERIMENT_REGISTRY,
    GA4_BEHAVIOR,
    INCLUDED_CLASSIFICATION,
    PAYMENT_LEDGER,
    SCHEMA_PREFIX,
    SUPPORTED_SCHEMA_VERSION,
)

MAX_COVERAGE_DAYS = 400
# Hours after a day ends (in the input's timezone) before its data is treated
# as settled. GA4 processing can revise a day for up to ~48h.
SETTLE_HOURS = {GA4_BEHAVIOR: 48, APP_OUTCOMES: 24, PAYMENT_LEDGER: 24}

Dims = Tuple[str, str, str, str, str]


@dataclass(frozen=True)
class LoadedDocument:
    kind: str
    doc: dict
    sha256: str


@dataclass(frozen=True)
class Ga4Record:
    date: date
    source: str
    medium: str
    campaign: str
    content: str
    landing_path: str
    sessions: int
    checkout_starts: int
    purchase_events: int

    @property
    def dims(self) -> Dims:
        return (self.source, self.medium, self.campaign, self.content, self.landing_path)


@dataclass(frozen=True)
class OutcomeRecord:
    conversion_ref: str
    outcome: str
    date: date
    source: str
    medium: str
    campaign: str
    content: str
    landing_path: str
    classification: str

    @property
    def dims(self) -> Dims:
        return (self.source, self.medium, self.campaign, self.content, self.landing_path)


@dataclass(frozen=True)
class PaymentRecord:
    conversion_ref: str
    event: str
    event_seq: int
    date: date
    amount_minor: int
    currency: str
    classification: str


_RECORD_TYPES: Dict[str, Tuple[type, Callable[[Any], Hashable]]] = {
    GA4_BEHAVIOR: (Ga4Record, lambda r: (r.date, r.dims)),
    APP_OUTCOMES: (OutcomeRecord, lambda r: (r.conversion_ref, r.outcome)),
    PAYMENT_LEDGER: (PaymentRecord, lambda r: (r.conversion_ref, r.event, r.event_seq)),
}


@dataclass(frozen=True)
class EvidenceInput:
    evidence_class: str
    business: str
    sha256: str
    data_origin: str
    timezone: str
    generated_at: datetime
    generated_at_text: str
    coverage_start: date
    coverage_end: date
    attested_days: FrozenSet[date]
    settled_days: FrozenSet[date]
    quality_flags: Tuple[str, ...]
    rows_in_file: int
    duplicate_rows_dropped: int
    records: Tuple[Any, ...]  # de-duplicated; customer rows only where classified
    excluded_records: Tuple[Any, ...]  # internal / test / sample rows
    currency: Optional[str] = None
    ref_key_id: Optional[str] = None

    @property
    def coverage_days(self) -> int:
        return (self.coverage_end - self.coverage_start).days + 1

    @property
    def completeness(self) -> str:
        if not self.records:
            return "empty"
        if self.quality_flags or len(self.settled_days) < self.coverage_days:
            return "partial"
        return "complete"

    def manifest(self) -> Dict[str, Any]:
        excluded: Optional[Dict[str, int]] = None
        if self.evidence_class != GA4_BEHAVIOR:
            counts = Counter(r.classification for r in self.excluded_records)
            excluded = {c: counts.get(c, 0) for c in CLASSIFICATIONS if c != INCLUDED_CLASSIFICATION}
        return {
            "evidence_class": self.evidence_class,
            "schema": SCHEMA_PREFIX + self.evidence_class,
            "schema_version": SUPPORTED_SCHEMA_VERSION,
            "business": self.business,
            "sha256": self.sha256,
            "data_origin": self.data_origin,
            "timezone": self.timezone,
            "generated_at": self.generated_at_text,
            "coverage_start": self.coverage_start.isoformat(),
            "coverage_end": self.coverage_end.isoformat(),
            "coverage_days": self.coverage_days,
            "gap_days": self.coverage_days - len(self.attested_days),
            "unsettled_days": len(self.attested_days) - len(self.settled_days),
            "quality_flags": list(self.quality_flags),
            "rows_in_file": self.rows_in_file,
            "rows_after_dedupe": self.rows_in_file - self.duplicate_rows_dropped,
            "duplicate_rows_dropped": self.duplicate_rows_dropped,
            "rows_included": len(self.records),
            "excluded_rows": excluded,
            "currency": self.currency,
            "conversion_ref_key_id": self.ref_key_id,
            "completeness": self.completeness,
            "validation_state": "accepted",
        }


def load_document(data: bytes) -> LoadedDocument:
    """Strict JSON + closed schema validation for any supported document."""
    # Oversized inputs are only partially read, so no digest can describe them.
    digest = sha256_hex(data) if len(data) <= MAX_INPUT_BYTES else None
    try:
        doc = parse_strict_json(data)
    except InputRejected as exc:
        raise InputRejected(exc.issues, digest) from None
    kind, issues = validate_document(doc)
    if issues or kind is None:
        raise InputRejected(issues, digest)
    return LoadedDocument(kind, doc, digest)


def load_evidence(data: bytes) -> EvidenceInput:
    loaded = load_document(data)
    if loaded.kind == EXPERIMENT_REGISTRY:
        raise InputRejected([Issue("NOT_EVIDENCE_SCHEMA", "$.schema")], loaded.sha256)
    return evidence_from_document(loaded)


def day_start_utc(day: date, tz: str) -> datetime:
    return datetime.combine(day, time(0), tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)


def _days(start: date, end: date) -> List[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def _attested_days(doc: dict, start: date, end: date, issues: List[Issue]) -> FrozenSet[date]:
    days: set = set()
    previous_end: Optional[date] = None
    for index, item in enumerate(doc["attested_complete_ranges"]):
        range_start, range_end = parse_date(item["start"]), parse_date(item["end"])
        ordered = previous_end is None or range_start > previous_end
        if range_start > range_end or range_start < start or range_end > end or not ordered:
            issues.append(Issue("ATTESTED_RANGE_INVALID", "$.attested_complete_ranges[{}]".format(index)))
            continue
        days.update(_days(range_start, range_end))
        previous_end = range_end
    return frozenset(days)


def _records(kind: str, rows: List[dict], start: date, end: date,
             issues: List[Issue]) -> Tuple[List[Tuple[int, Any]], int]:
    """Typed, de-duplicated records with their row index; exact duplicates dropped."""
    record_type, key_of = _RECORD_TYPES[kind]
    seen: Dict[Hashable, Any] = {}
    unique: List[Tuple[int, Any]] = []
    dropped = 0
    for index, row in enumerate(rows):
        record = record_type(**dict(row, date=parse_date(row["date"])))
        if not start <= record.date <= end:
            issues.append(Issue("ROW_OUTSIDE_COVERAGE", "$.rows[{}].date".format(index)))
            continue
        key = key_of(record)
        if key not in seen:
            seen[key] = record
            unique.append((index, record))
        elif seen[key] == record:
            dropped += 1
        else:
            issues.append(Issue("CONFLICTING_DUPLICATE", "$.rows[{}]".format(index)))
    return unique, dropped


def _check_ga4(records: List[Tuple[int, Ga4Record]], issues: List[Issue]) -> None:
    for index, record in records:
        if record.checkout_starts > record.sessions or record.purchase_events > record.sessions:
            issues.append(Issue("METRIC_INVARIANT", "$.rows[{}]".format(index)))


def _check_ledger(records: List[Tuple[int, PaymentRecord]], issues: List[Issue]) -> None:
    classification: Dict[str, str] = {}
    charge_seqs: Dict[str, set] = {}
    charged: Counter = Counter()
    refunded: Counter = Counter()
    first_refund: Dict[str, int] = {}
    for index, record in records:
        ref = record.conversion_ref
        if classification.setdefault(ref, record.classification) != record.classification:
            issues.append(Issue("CLASSIFICATION_MISMATCH", "$.rows[{}]".format(index)))
        if record.event == "charge":
            charge_seqs.setdefault(ref, set()).add(record.event_seq)
            charged[ref] += record.amount_minor
        else:
            refunded[ref] += record.amount_minor
            first_refund.setdefault(ref, index)
    for ref, index in sorted(first_refund.items(), key=lambda item: item[1]):
        seqs = charge_seqs.get(ref)
        # Only a complete charge history (seq 1..n present) can prove an over-refund;
        # otherwise the original charge may predate coverage.
        if seqs and seqs == set(range(1, max(seqs) + 1)) and refunded[ref] > charged[ref]:
            issues.append(Issue("REFUND_EXCEEDS_CHARGE", "$.rows[{}]".format(index)))


def evidence_from_document(loaded: LoadedDocument) -> EvidenceInput:
    doc, kind = loaded.doc, loaded.kind
    issues: List[Issue] = []
    start, end = parse_date(doc["coverage"]["start"]), parse_date(doc["coverage"]["end"])
    if start > end:
        raise InputRejected([Issue("COVERAGE_RANGE_INVALID", "$.coverage")], loaded.sha256)
    if (end - start).days + 1 > MAX_COVERAGE_DAYS:
        raise InputRejected([Issue("COVERAGE_TOO_LONG", "$.coverage")], loaded.sha256)
    tz = doc["timezone"]
    generated_at = parse_timestamp(doc["generated_at"]).replace(tzinfo=timezone.utc)
    if day_start_utc(end, tz) >= generated_at:
        issues.append(Issue("COVERAGE_AFTER_GENERATED_AT", "$.coverage.end"))

    attested = _attested_days(doc, start, end, issues)
    records, dropped = _records(kind, doc["rows"], start, end, issues)
    if kind == GA4_BEHAVIOR:
        _check_ga4(records, issues)
    elif kind == PAYMENT_LEDGER:
        _check_ledger(records, issues)
    if issues:
        raise InputRejected(issues, loaded.sha256)

    settle = timedelta(hours=SETTLE_HOURS[kind])
    settled = frozenset(day for day in attested if day_start_utc(day + timedelta(days=1), tz) + settle <= generated_at)
    typed = [record for _, record in records]
    if kind == GA4_BEHAVIOR:
        quality = doc["quality"]
        flags = tuple(code for key, code in (("sampled", "GA4_SAMPLED"), ("thresholded", "GA4_THRESHOLDED"),
                                             ("other_row", "GA4_OTHER_ROW")) if quality[key])
        included, excluded = typed, []
    else:
        flags = ()
        included = [r for r in typed if r.classification == INCLUDED_CLASSIFICATION]
        excluded = [r for r in typed if r.classification != INCLUDED_CLASSIFICATION]

    return EvidenceInput(
        evidence_class=kind,
        business=doc["business"],
        sha256=loaded.sha256,
        data_origin=doc["data_origin"],
        timezone=tz,
        generated_at=generated_at,
        generated_at_text=doc["generated_at"],
        coverage_start=start,
        coverage_end=end,
        attested_days=attested,
        settled_days=settled,
        quality_flags=flags,
        rows_in_file=len(doc["rows"]),
        duplicate_rows_dropped=dropped,
        records=tuple(included),
        excluded_records=tuple(excluded),
        currency=doc.get("currency"),
        ref_key_id=doc.get("conversion_ref_key_id"),
    )
