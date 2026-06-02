# HSB Kill-Switch Console Implementation - 2026-06-01

Status: local candidate implementation on `hsb/ks-console-20260601`. No deploy, push, production mutation, order/customer/payment mutation, Stripe, Lulu/RPI, Resend, customer email, or print action was performed.

## Surface

- Admin page: `/admin/kill-switches`
- Admin API: `/api/admin/kill-switches`
- State storage:
  - **Production (Vercel / NODE_ENV=production / HSB_REQUIRE_DURABLE_PERSISTENCE=true)**: Vercel Blob at `ops/state/hsb-kill-switches.json` (namespaced via `withBlobNamespace`). Missing `BLOB_READ_WRITE_TOKEN` fails closed via `KillSwitchDurabilityError` → admin route 503 + `code: DURABILITY_FAILED`; every enforcement seam refuses the protected action. The admin page renders a hard "UNSAFE TO USE" warning instead of the toggle UI.
  - **Dev/test only**: filesystem at `ops/state/hsb-kill-switches.json` (override via `HSB_KILL_SWITCH_STATE_PATH`). The file-based path is NEVER used in production — per-Vercel-function-instance FS would yield divergent KS state and a console that does not actually halt anything. This was an overclaim in the original implementation; corrected 2026-06-02.
- Auth: same admin cookie/header helper used by the existing HSB admin surfaces.

## Switch Status

- KS-1 `checkout_pause`: enforced. `/api/order` refuses before form parsing, uploads, or Stripe Checkout session creation.
- KS-2 `proof_release_hold`: enforced at EVERY admin path that sends customer email — `releaseOrderAfterQa`, `resendDigitalDelivery`, `resendProofEmail`, and `retryOrderFulfillment`'s `delivery_email_failed` branches. `manuallyApproveProof` is intentionally NOT gated because it sends no customer email (docstring records the scope). The earlier "only releaseOrderAfterQa" wiring was a leak; closed 2026-06-02.
- KS-3 `owner_print_go_hold`: enforced. `recordOwnerPrintGo` / `submitPrintAfterOwnerGo` refuse before owner print-go lock acquisition or print submission.
- KS-4 `marketing_hold`: manual/status-only. The app has no single paid-traffic, creator, gifting, or social-posting integration to block.
- KS-5 `provider_hold`: manual/status-only. Generation routing still relies on route/provenance guards rather than one global provider toggle.
- KS-6 `print_provider_hold`: enforced. `submitPrintAfterOwnerGo` refuses before owner-go lock when active, and `runPrintProduction` also refuses before Lulu/RPI provider submission.

## Validation

- Activating any switch requires nonblank `updatedBy`.
- Activating a switch requires a nonblank reason.
- Switch changes append local history for operator review.
- Existing `HSB_CHECKOUT_PAUSED=true` remains a separate env-level checkout pause and is displayed on the admin page.

## Fail-closed semantics (post-2026-06-02 hardening)

Every kill-switch enforcement seam now uses `enforceKillSwitch(id)` which returns a tagged discriminated union (`inactive` / `active` / `unavailable`). A durable-store read failure (Blob outage / missing token in production) returns `{ kind: 'unavailable', reason }`, which each seam treats as a refusal:

- `/api/order` (KS-1): returns 503 with `killSwitchStateUnavailable: true`.
- `releaseOrderAfterQa` / `resendDigitalDelivery` / `resendProofEmail` / `retryOrderFulfillment` (KS-2): returns ActionResult with `failureCode: 'KILL_SWITCH_STATE_UNAVAILABLE'` and HTTP 503.
- `recordOwnerPrintGo` / `submitPrintAfterOwnerGo` (KS-3): refuses with `failureCode: 'OWNER_PRINT_GO_HELD'` carrying the durability reason.
- `runPrintProduction` / `submitPrintAfterOwnerGo` (KS-6): refuses with `failureCode: 'PRINT_PROVIDER_HELD'` and appends a `print_submission_blocked` audit event with `reason: 'KILL_SWITCH_STATE_UNAVAILABLE'`.

Strict policy: a kill switch we cannot read is a kill switch we cannot trust, so every protected action refuses. The trade-off is checkout / admin operations fail during a Blob outage — intentional.

## Remaining Manual Risk

Resend bounce monitoring is implemented as a signed-webhook ingestion route + read-only admin monitor at `/admin/email-health`; see `docs/ops/hsb-resend-bounce-monitoring-2026-06-02.md`. Production activation still requires the two manual setup steps (Vercel env var + Resend dashboard webhook registration). After the 2026-06-02 hardening the webhook persistence is also fail-closed: missing `BLOB_READ_WRITE_TOKEN` or any persist failure returns 503 + `code: PERSISTENCE_FAILED` so Svix retries instead of the route silently 200-acking events we cannot read back.
