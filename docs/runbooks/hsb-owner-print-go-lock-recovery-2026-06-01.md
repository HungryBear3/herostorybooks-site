# HSB Owner Print-Go Lock Recovery Runbook — 2026-06-01

Status: pre-G5 hardening artifact. Read end-to-end before invoking the
recovery action against any paid order.

## When to use this

Use this procedure only when ALL of the following are true on the admin
order detail page:

- `fulfillmentStatus` is `submitting_to_print` OR `failed_manual_review`.
- `ownerPrintGoAt` is set.
- `printJobId` is empty.
- The admin Owner Print Go Console shows the amber
  "Stuck owner-print-go lock detected" recovery panel (visibility is
  gated on the same predicate as above).

Do NOT use this procedure if `printJobId` is set or `order.status` is
`print_in_production` / `shipped`. The action will refuse with
`PRINT_ALREADY_SUBMITTED` / `ORDER_ALREADY_IN_PRINT_OR_SHIPPED`, but the
underlying meaning is: a real print job exists at the provider and must
not be invalidated by clearing the lock.

## Background

`acquireOwnerPrintGoIntentLock` (in `src/lib/orders.ts`) creates a
durable blob-or-FS lock before any Lulu/RPI submit. The lock is a
one-shot guard: it is intentionally never deleted on the success path so
future owner-go attempts refuse before re-submitting print.

If the print submit fails — Lulu/RPI returns 5xx, the network times out,
the process restarts mid-flow, or `updateFulfillmentState` returns null
after lock acquisition — the lock remains in place but no `printJobId`
gets persisted. The order is stuck:

- The Owner Print Go Console shows owner-go as recorded.
- A retry of owner-go from the UI returns `RACE_LOST` (the lock is held
  by … nothing).
- Without this recovery action, the only fix is manual blob/FS surgery.

`releaseOwnerPrintGoLock` is the only safe in-product recovery path. It
deletes the lock blob + FS lock, clears `ownerPrintGoAt` /
`ownerPrintGoBy` / `ownerPrintGoLockToken`, reverts `fulfillmentStatus`
to `proof_approved`, clears `fulfillmentLastError`, and appends an
`owner_print_go_lock_released` audit event.

## Safety checklist — REQUIRED before clicking Clear

Run all of these in order. If any answer is "no" or "uncertain", stop.

1. Open the print provider dashboard (Lulu today; RPI is not selected
   per `docs/ops/hsb-print-path-sla-decision-2026-06-01.md`).
2. Search by HSB order id (Lulu records this as `external_id`).
3. Confirm NO print job exists at the provider for this order id. If a
   job DOES exist:
   - Do NOT clear the lock.
   - Document the provider job id, status, and submission timestamp in
     the run log.
   - Escalate to Alexy. The HSB record needs the provider's job id
     written to `printJobId` manually before any other action; this
     runbook does not cover that case.
4. If no provider job exists, also verify:
   - The `Idempotency-Key` Lulu received was the same order id (logs
     from the provider should show this). If the provider rejected the
     submit cleanly (e.g. validation 4xx), no job was created and
     recovery is safe.
   - The `fulfillmentLastError` shown on the admin page describes a
     pre-submit or transport-level failure, not a 2xx-with-no-body
     scenario.
5. Capture: order id, `fulfillmentLastError` text, provider dashboard
   screenshot showing no job, your operator id, current deploy commit
   (visible in admin diagnostics).

## How to clear

### Via the admin UI (preferred)

1. Open `/admin/orders/<orderId>` while signed in with the admin cookie.
2. Scroll to the Owner Print Go Console.
3. Click "Open lock-recovery action" in the amber stuck-lock panel.
4. Tick the acknowledgement checkbox (asserts you have checked the
   provider dashboard).
5. Type your operator id (the audit will record exactly this string —
   use your actual name, not a generic 'admin').
6. Click "Clear stuck owner-print-go lock".
7. The page refreshes. Confirm:
   - `fulfillmentStatus` is now `proof_approved`.
   - `ownerPrintGoAt`, `ownerPrintGoBy`, `ownerPrintGoLockToken` are all
     empty.
   - The audit trail shows `owner_print_go_lock_released` with your
     `releasedBy` value and the prior state captured in `meta`.

### Via direct HTTP (operator CLI, last resort)

If the admin UI is unavailable:

```bash
curl -X POST "$BASE_URL/api/admin/orders/$ORDER_ID/print-go-lock" \
  -H 'Content-Type: application/json' \
  -H "Cookie: hsb_admin=<your admin cookie>" \
  -d '{"ownerBy": "alexy"}'
```

Expected on success: HTTP 200 with `{"ok": true, "detail": "Owner
print-go lock released by alexy; order restored to proof_approved."}`.

Refusal HTTP statuses and their meaning:

- `400 OWNER_BY_REQUIRED` — operator id was blank after trim.
- `404 ORDER_NOT_FOUND` — the order id is unknown.
- `409 PRINT_ALREADY_SUBMITTED` — `printJobId` is set. Do not retry;
  follow step 3 above.
- `409 ORDER_ALREADY_IN_PRINT_OR_SHIPPED` — `order.status` is
  `print_in_production` or `shipped`. Do not retry.
- `409 NO_LOCK_TO_RELEASE` — no lock evidence on the order. Nothing to
  recover; the page may be stale — refresh.
- `502 PERSIST_FAILED` — the lock was deleted but the order state
  revert write failed. Re-attempt; the action is idempotent on the lock
  side.

## After recovery

The order is back to `proof_approved`. The operator may:

- Investigate why the original owner-go submit failed
  (`fulfillmentLastError` was captured into the audit event meta as
  `priorFulfillmentLastError`).
- Re-attempt owner-go via the same console panel once the root cause is
  resolved.
- Or, if the failure was provider-side and the operator cannot guarantee
  another attempt is safe, leave the order at `proof_approved` and
  escalate.

## Out of scope for this action

This action does NOT:

- Issue a refund (use the pre-print refund action; see
  `recordRefundForOrder` in `src/lib/admin-actions.ts`).
- Clear `printJobId` if one was already persisted (refuses with
  `PRINT_ALREADY_SUBMITTED`).
- Cancel a real print job at the provider (must be done in the provider
  dashboard).
- Touch QA, customer approval, or proof artifacts.
