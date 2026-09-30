"""Naming conventions for campaigns, content, landing paths, refs and experiments.

Campaign  : <business>_<yyyymm>_<objective>_<slug>   e.g. hsb_202609_acq_fallbooks
Content   : <format>_<variant>                       e.g. vid_a
Landing   : normalized absolute path template        e.g. /fall-books
Ref       : cr1_<key id>_<26 Crockford base32 chars> (operator-keyed MAC, opaque)
Experiment: <business>_exp_<yyyy>_<nnn>              e.g. hsb_exp_2026_001

All functions return a list of issue codes; an empty list means valid.
"""

from __future__ import annotations

import re
from typing import List, Optional

from .identifiers import forbidden_value_code
from .vocab import (BUSINESSES, CAMPAIGN_OBJECTIVES, CONTENT_FORMATS,
                    CAMPAIGN_SLUGS, CONTENT_VARIANTS, LANDING_PATHS)

_YYYYMM = re.compile(r"20[2-9]\d(?:0[1-9]|1[0-2])")
_SEGMENT = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_MAX_SEGMENTS = 4
_MAX_SEGMENT_LENGTH = 40
_MAX_SEGMENT_DIGITS = 4
_REF_NAMESPACE = "cr1_"
_REF = re.compile(r"cr1_(k\d{2})_[0-9A-HJKMNP-TV-Z]{26}")
_EXPERIMENT_ID = re.compile(r"(" + "|".join(BUSINESSES) + r")_exp_20[2-9]\d_\d{3}")


def _forbidden(value: str) -> List[str]:
    code = forbidden_value_code(value)
    return ["FORBIDDEN_VALUE:" + code] if code else []


def _digit_count(value: str) -> int:
    return sum(ch.isdigit() for ch in value)


def campaign_issues(name: str, business: Optional[str] = None) -> List[str]:
    forbidden = _forbidden(name)
    if forbidden:
        return forbidden
    parts = name.split("_")
    if len(parts) != 4:
        return ["CAMPAIGN_SHAPE"]
    prefix, month, objective, slug = parts
    issues = []
    if prefix not in BUSINESSES:
        issues.append("CAMPAIGN_BUSINESS")
    elif business is not None and prefix != business:
        issues.append("CAMPAIGN_BUSINESS_MISMATCH")
    if not _YYYYMM.fullmatch(month):
        issues.append("CAMPAIGN_MONTH")
    if objective not in CAMPAIGN_OBJECTIVES:
        issues.append("CAMPAIGN_OBJECTIVE")
    if slug not in CAMPAIGN_SLUGS:
        issues.append("CAMPAIGN_SLUG")
    return issues


def content_issues(name: str) -> List[str]:
    forbidden = _forbidden(name)
    if forbidden:
        return forbidden
    parts = name.split("_")
    if len(parts) != 2:
        return ["CONTENT_SHAPE"]
    fmt, variant = parts
    issues = []
    if fmt not in CONTENT_FORMATS:
        issues.append("CONTENT_FORMAT")
    if variant not in CONTENT_VARIANTS:
        issues.append("CONTENT_VARIANT")
    return issues


def landing_path_issues(path: str) -> List[str]:
    forbidden = _forbidden(path)
    if forbidden:
        return forbidden
    if path == "/":
        return []
    if not path.startswith("/"):
        return ["LANDING_PATH_NOT_ABSOLUTE"]
    if path.endswith("/"):
        return ["LANDING_PATH_TRAILING_SLASH"]
    segments = path[1:].split("/")
    if len(segments) > _MAX_SEGMENTS:
        return ["LANDING_PATH_TOO_DEEP"]
    issues: List[str] = []
    for segment in segments:
        if not _SEGMENT.fullmatch(segment) or len(segment) > _MAX_SEGMENT_LENGTH:
            code = "LANDING_PATH_SEGMENT"
        elif _digit_count(segment) > _MAX_SEGMENT_DIGITS:
            # Order numbers, PINs, zip codes and similar identifiers in paths.
            code = "LANDING_PATH_IDENTIFIER_SEGMENT"
        else:
            continue
        if code not in issues:
            issues.append(code)
    if not issues and path not in LANDING_PATHS:
        issues.append("LANDING_PATH_NOT_APPROVED")
    return issues


def conversion_ref_issues(ref: str, key_id: Optional[str] = None) -> List[str]:
    match = _REF.fullmatch(ref)
    if match is None:
        # Inside the ref namespace a miss is a format error; outside it, name
        # what the value looks like (provider id, unkeyed hash, email, ...).
        if ref.startswith(_REF_NAMESPACE):
            return ["CONVERSION_REF_FORMAT"]
        return _forbidden(ref) or ["CONVERSION_REF_FORMAT"]
    if key_id is not None and match.group(1) != key_id:
        return ["CONVERSION_REF_KEY_MISMATCH"]
    return []


def experiment_id_issues(experiment_id: str, business: Optional[str] = None) -> List[str]:
    forbidden = _forbidden(experiment_id)
    if forbidden:
        return forbidden
    match = _EXPERIMENT_ID.fullmatch(experiment_id)
    if match is None:
        return ["EXPERIMENT_ID_FORMAT"]
    if business is not None and match.group(1) != business:
        return ["EXPERIMENT_ID_BUSINESS_MISMATCH"]
    return []
