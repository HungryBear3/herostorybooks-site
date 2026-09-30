"""Fixed vocabularies (explicit allowlists) shared by every schema.

Anything not listed here is rejected. Extending a vocabulary is a deliberate,
versioned code change, never an input-driven one.
"""

from __future__ import annotations

BUSINESSES = ("hsb", "ot")

GA4_BEHAVIOR = "ga4_behavior"
APP_OUTCOMES = "app_outcomes"
PAYMENT_LEDGER = "payment_ledger"
EXPERIMENT_REGISTRY = "experiment_registry"
EVIDENCE_CLASSES = (GA4_BEHAVIOR, APP_OUTCOMES, PAYMENT_LEDGER)

SCHEMA_PREFIX = "decision_packet."
SCHEMA_KINDS = {SCHEMA_PREFIX + kind: kind for kind in EVIDENCE_CLASSES + (EXPERIMENT_REGISTRY,)}
SUPPORTED_SCHEMA_VERSION = 1

DATA_ORIGINS = ("synthetic_fixture", "operator_export")

TIMEZONES = (
    "UTC",
    "America/Chicago",
    "America/New_York",
    "America/Denver",
    "America/Los_Angeles",
)

# Normalized traffic sources / mediums. Exporters must map raw GA4 values into
# these (e.g. "(direct)" -> direct, "l.facebook.com" -> facebook) and collapse
# anything else into "other"; raw strings are never accepted.
SOURCES = (
    "direct", "google", "bing", "duckduckgo", "yahoo", "facebook", "instagram",
    "tiktok", "pinterest", "youtube", "linkedin", "reddit", "x", "nextdoor",
    "newsletter", "chatgpt", "perplexity", "referral_other", "other", "not_set",
)
MEDIUMS = (
    "none", "organic", "cpc", "paid_social", "social", "email", "referral",
    "display", "affiliate", "sms", "qr", "other", "not_set",
)

# Placeholder values allowed in observed data (never in the registry, except
# content "none"). They cannot collide with conforming names.
CAMPAIGN_SENTINELS = ("none", "not_set", "other")
CONTENT_SENTINELS = ("none", "not_set", "other")
LANDING_PATH_SENTINELS = ("not_set", "other")

CAMPAIGN_OBJECTIVES = ("acq", "rtg", "ret", "brand", "season")
CONTENT_FORMATS = ("img", "vid", "txt", "car", "eml", "srch")

# Reviewed exact public labels and synthetic test labels, NOT prefix patterns.
# Extend only through a reviewed version-controlled change (see README).
CAMPAIGN_SLUGS = (
    "fallbooks", "synthalpha", "synthbeta", "synthgamma", "synthappeal",
    "synthreminder", "ab",
)
CONTENT_VARIANTS = ("a", "b", "b2", "v2")
LANDING_PATHS = (
    "/", "/fall-books", "/books/fall-2026", "/a/b/c/d",
    "/synthetic-offer-a", "/synthetic-offer-b", "/synthetic-offer-c",
    "/synthetic-appeal-check", "/synthetic-guide", "/synthetic-deadline",
)

# ISO 4217 code -> minor-unit exponent.
CURRENCIES = {"USD": 2, "CAD": 2, "EUR": 2, "GBP": 2}

CLASSIFICATIONS = ("customer", "internal", "test", "sample")
INCLUDED_CLASSIFICATION = "customer"

PAYMENT_EVENTS = ("charge", "refund")
OUTCOME_TYPES = ("qualified_action",)

EXPERIMENT_STATUSES = ("planned", "running", "paused", "completed", "cancelled")
OPEN_STATUSES = ("planned", "running", "paused")
DECISIONS = ("pending", "continue", "scale", "iterate", "stop")
PRIMARY_OUTCOMES = (
    "qualified_action_rate",
    "checkout_start_rate",
    "paid_order_rate",
    "paid_per_qualified_rate",
    "net_revenue_per_session",
)
