# HSB Lane A zero-send census — 2026-08-25

Status: **GET-only evidence complete; activation remains off.**

## Exact candidate

- Branch: `rex/hsb-incident-observability-20260824`
- Base after reconciliation: released `main` at `e0f7cfd`
- Candidate commit: record from Git after the bounded cooldown change is committed

## Method

The local candidate imported the production order reader and incident classifier, then:

- enumerated orders through `listOrdersAuthoritative()` using the existing production Blob credential;
- supplied an empty in-memory cooldown ledger;
- replaced the alert sink with an in-memory aggregate counter;
- replaced cooldown persistence with an in-memory write counter;
- emitted no order identifiers, customer fields, tokens, provider ids, or artifact URLs;
- made zero durable writes and zero external sends.

The first rehearsal was rejected as invalid because a freshly pulled Vercel environment exported
the sensitive Blob credential as blank and therefore scanned zero records. It was rerun with the
existing protected local production environment file; the authoritative census then scanned 52
records. The rejected false-zero run is not evidence.

## Aggregate result

- Scanned: **52**
- Incidents classified: **9**
- Would alert: **9**
- External sends: **0**
- Durable writes: **0**
- Result: degraded, not failed (`data_quality_uncertain`)
- Aggregate classes:
  - `data_quality_uncertain`: 5
  - `failed_manual_review`: 2
  - `manual_hold_sla`: 1
  - `customer_review_wait_overdue`: 1

This validates complete enumeration and deterministic classification without activating delivery.
It also proves that activation would be noisy until the five legacy data-quality records and the
other four incident dispositions are reviewed.

## Cooldown storage correction

- Cooldown state now requires `HSB_PRIVATE_READ_WRITE_TOKEN` and uses private Blob access.
- It refuses a private token that equals `BLOB_READ_WRITE_TOKEN`; there is no public-store fallback.
- Expired history is pruned and the ledger is capped at 1,000 entries.
- If more than 1,000 keys are still actively suppressing alerts, the scan fails closed rather than
  dropping idempotency and risking duplicate alerts.

## Gates still closed

- No cron or schedule.
- No email, Slack, Discord, Telegram, webhook, or customer notification sink.
- No cadence or recipient configured.
- No Production scan route invocation.
- No order, payment, proof, fulfillment, print, provider, or customer mutation.
- The legacy public cooldown object, if present, was not read, migrated, or deleted in this lane.

Recommendation: release the dormant read-only classifier and private bounded storage, but keep
activation held until the nine aggregate findings are dispositioned and Alexy approves exact
thresholds, cadence, and channel.
