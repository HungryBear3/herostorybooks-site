# HSB Resend Bounce Monitoring — 2026-06-02

Status: implementation landed locally on the deploy-candidate branch.
Until the steps below are completed in Vercel + the Resend dashboard,
the monitor renders an unconfigured-warning banner and the webhook
route refuses all inbound events with 503. This is fail-closed by
design — operators must not interpret an empty event list as healthy
delivery.

## What's in the repo

- `src/lib/resend-events.ts` — pure events module. Allowlisted Resend
  event types (`email.sent`, `email.delivered`, `email.bounced`,
  `email.complained`, `email.delivery_delayed`, `email.opened`,
  `email.clicked`); persisted to day-partitioned JSONL logs (blob in
  prod, FS in dev/test); idempotent on Svix `msg_id`; read helpers
  scan ≤14 days back.
- `src/app/api/webhooks/resend/route.ts` — signed-webhook ingestion.
  Requires `RESEND_WEBHOOK_SECRET`; verifies `svix-signature` HMAC
  before any persistence; drops unknown event types with a 200-ack
  (no infinite Svix retries) and never persists them. Performs NO
  outbound network calls.
- `src/app/admin/email-health/page.tsx` — read-only admin monitor.
  Cookie-auth-gated; shows trailing-24h bucket counts, recent bounces
  + complaints, last 50 events. Renders an explicit warning banner
  when `RESEND_WEBHOOK_SECRET` is unset.
- `tests/resend-events.test.ts` — 16 tests covering type allowlist,
  normalization, idempotency, list/summary, route security
  invariants (secret required, headers required, HMAC before persist,
  unknown types dropped, no outbound calls), and admin page auth
  ordering.
- `docs/ops/hsb-resend-bounce-monitoring-2026-06-02.md` — this file.

## What's NOT in the repo (manual ops setup REQUIRED before traffic)

The webhook will refuse all inbound events with HTTP 503 until BOTH
of these are configured in production:

1. **`RESEND_WEBHOOK_SECRET` set in Vercel.** Provided by Resend when
   you create a webhook in the dashboard; format is `whsec_<base64>`.
   Add via Vercel project settings → environment variables → Production.
   Do NOT commit to repo.
2. **Webhook endpoint registered in Resend dashboard.** Point at
   `https://<production-deploy>/api/webhooks/resend`. Subscribe at
   minimum to:
     - `email.bounced`
     - `email.complained`
     - `email.delivery_delayed`
     - `email.delivered`
   Optionally also `email.sent`, `email.opened`, `email.clicked` for
   richer telemetry; the route accepts all seven types.

## Daily ops check while YELLOW

After the above are configured:

- Open `/admin/email-health` once per business day.
- Confirm trailing-24h `email.bounced` count is **0** (or each bounce
  has an actionable disposition recorded by ops).
- Confirm `email.complained` is **0**. A single complaint should
  trigger a same-day review of who we sent to and why.
- If `email.delivery_delayed` is non-zero, check the Resend dashboard
  for the actual reason and recipient domain.
- If `email.bounced` is **≥ 5%** of `email.delivered` in any 24h
  window, pause checkout (`HSB_CHECKOUT_PAUSED=true` via the existing
  KS-1 kill switch) and escalate to Alexy before resuming.

## Until the manual setup happens — manual-risk fallback

Operators must take ALL of the following daily during any approved
traffic window:

1. Log into the Resend dashboard.
2. Filter the email log to the last 24h.
3. Spot-check for bounces / complaints / delays.
4. Record the check (date + operator) in the run log.
5. If any anomaly is found, pause checkout immediately via the KS-1
   admin console at `/admin/kill-switches` and escalate.

This is **not** acceptable for sustained public/creator/gifting
traffic; it is acceptable only for a controlled G5 paid owner-test
plus internal smoke runs. The setup steps above must be completed
before broader traffic.

## Security posture

- Webhook secret is required. Missing secret → 503 (fail-closed).
- Signature is verified with constant-time comparison.
- Unknown event types are dropped at the ingestion seam — never
  persisted to the log.
- Persisted fields are operator-visible only (recipient, subject,
  bounce reason). No email body, no HTML, no click URLs are stored.
- The admin monitor is read-only and admin-auth-gated. There is no
  mutation endpoint.
- No outbound network calls from the webhook route or the admin
  monitor.

## How to verify

```bash
# Tests
TMPDIR=/tmp node --experimental-strip-types --test tests/resend-events.test.ts
# 16/16 pass

# After deploy: synthetic test (Resend dashboard "send test event")
# Should hit /api/webhooks/resend and persist under the day-partition.
# Then /admin/email-health should render the event in the recent list.
```

## Out of scope for this slice

- Automatic checkout pause on bounce-rate thresholds (currently
  manual via KS-1).
- Recipient-suppression list integration.
- Alerting (PagerDuty / Slack). The monitor is poll-based; alerts
  belong to a future slice.
- Backfilling bounce/complaint history from the Resend API. Only
  events delivered via webhook after configuration are captured.
