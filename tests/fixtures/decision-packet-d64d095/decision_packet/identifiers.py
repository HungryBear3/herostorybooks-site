"""Detection of free text, URLs and personal / provider identifiers.

Every schema field is already pattern- or enum-constrained; this detector is the
defense-in-depth layer that turns a rejection into a specific, value-free code
(for example FORBIDDEN_VALUE:STRIPE_ID instead of a generic pattern miss).
"""

from __future__ import annotations

import re
from typing import Optional

MAX_VALUE_LENGTH = 96

_URL = re.compile(
    r"://|^//|^www\.|\.(?:com|net|org|io|co|us|app|dev|ai|info|biz|edu|gov)(?:[/:?#]|$)",
    re.IGNORECASE,
)
_QUERY = re.compile(r"[?&=#%]")
_STRIPE_PREFIXES = (
    "acct", "ba", "bpc", "card", "ch", "cn", "cs", "cus", "dp", "du", "evt", "fr",
    "ic", "ii", "il", "in", "ipi", "pi", "pm", "po", "price", "prod", "promo", "py",
    "pyr", "re", "seti", "si", "src", "sub", "tok", "tr", "trr", "txn", "txr",
)
# Stripe ids carry a random base62 body, so an all-lowercase word after a
# prefix (e.g. "promo_synthalpha") is a naming slip, not a provider id.
_STRIPE_ID = re.compile(
    r"(?<![A-Za-z0-9])(?:" + "|".join(_STRIPE_PREFIXES) + r")_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{8,}"
)
_GA_CLIENT_ID = re.compile(r"(?<!\d)\d{6,}\.\d{6,}(?!\d)|^GA\d\.\d", re.IGNORECASE)
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# Cook County Property Index Number, dashed form (10 or 14 digits).
_PROPERTY_PIN = re.compile(r"(?<!\d)\d{2}-\d{2}-\d{3}-\d{3}(?:-\d{4})?(?!\d)")
_PHONE = re.compile(r"(?<!\d)\(?\d{3}\)?[-.]\d{3}[-.]\d{4}(?!\d)")
_HEX_HASH = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])")
_OPAQUE_TOKEN = re.compile(r"[A-Za-z0-9]{33,}")
_NUMERIC_ID = re.compile(r"\d{7,}")

_ORDERED_PATTERNS = (
    ("URL", _URL),
    ("QUERY_STRING", _QUERY),
    ("STRIPE_ID", _STRIPE_ID),
    ("GA_CLIENT_ID", _GA_CLIENT_ID),
    ("UUID", _UUID),
    ("PROPERTY_PIN", _PROPERTY_PIN),
    ("PHONE", _PHONE),
    ("UNKEYED_HASH", _HEX_HASH),
    ("OPAQUE_TOKEN", _OPAQUE_TOKEN),
    ("NUMERIC_IDENTIFIER", _NUMERIC_ID),
)


def forbidden_value_code(value: str) -> Optional[str]:
    """Return a category code if ``value`` looks like free text, a URL or an identifier."""
    if any(ch.isspace() for ch in value):
        return "FREE_TEXT"
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in value):
        return "NON_ASCII"
    if len(value) > MAX_VALUE_LENGTH:
        return "FREE_TEXT"
    if "@" in value:
        return "EMAIL"
    for code, pattern in _ORDERED_PATTERNS:
        if pattern.search(value):
            return code
    return None


# Unknown keys are rejected regardless; the category only sharpens the message.
# Order matters: the first matching category wins.
_KEY_CATEGORIES = (
    ("EMAIL", {"email", "mail", "emailaddress"}),
    ("PHONE", {"phone", "telephone", "tel", "mobile"}),
    ("IP", {"ip", "ipaddress", "ipaddr"}),
    ("ADDRESS", {"address", "street", "zip", "zipcode", "postal", "postcode", "city"}),
    ("PROPERTY", {"pin", "parcel", "property", "apn", "township"}),
    ("STRIPE", {"stripe", "charge", "paymentintent", "intent", "checkout", "invoice", "payout"}),
    ("GA_IDENTIFIER", {"client", "clientid", "cid", "pseudo", "userpseudoid", "gclid", "fbclid", "ga", "gaid"}),
    ("ORDER", {"order", "orderid", "receipt", "transaction", "txn"}),
    ("CUSTOMER", {"customer", "user", "userid", "account", "member", "buyer", "payer", "person"}),
    ("URL", {"url", "uri", "href", "link", "referrer", "referer", "location", "query", "querystring", "utm"}),
    ("FREE_TEXT", {"note", "notes", "comment", "comments", "description", "message", "memo", "text",
                   "hypothesis", "details", "remarks"}),
    ("NAME", {"name", "firstname", "lastname", "fullname", "surname"}),
)
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_KEY_TOKEN = re.compile(r"[a-z]+|[0-9]+")


def forbidden_key_code(key: str) -> str:
    """Classify an unknown object key without ever echoing it."""
    value_code = forbidden_value_code(key)
    if value_code is not None:
        return "FORBIDDEN_KEY:" + value_code
    lowered = _CAMEL_BOUNDARY.sub("_", key).lower()
    tokens = set(_KEY_TOKEN.findall(lowered))
    tokens.add(re.sub(r"[^a-z0-9]", "", lowered))
    for category, names in _KEY_CATEGORIES:
        if tokens & names:
            return "FORBIDDEN_KEY:" + category
    return "UNKNOWN_KEY"
