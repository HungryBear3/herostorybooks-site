# HSB Kill-Switch Console Implementation - 2026-06-01

Status: local candidate implementation on `hsb/ks-console-20260601`. No deploy, push, production mutation, order/customer/payment mutation, Stripe, Lulu/RPI, Resend, customer email, or print action was performed.

## Surface

- Admin page: `/admin/kill-switches`
- Admin API: `/api/admin/kill-switches`
- State file: `ops/state/hsb-kill-switches.json` by default, with `HSB_KILL_SWITCH_STATE_PATH` available for tests/local isolation.
- Auth: same admin cookie/header helper used by the existing HSB admin surfaces.

## Switch Status

- KS-1 `checkout_pause`: enforced. `/api/order` refuses before form parsing, uploads, or Stripe Checkout session creation.
- KS-2 `proof_release_hold`: enforced. `releaseOrderAfterQa` refuses before release state advance, release email lock, or customer email transport.
- KS-3 `owner_print_go_hold`: enforced. `recordOwnerPrintGo` / `submitPrintAfterOwnerGo` refuse before owner print-go lock acquisition or print submission.
- KS-4 `marketing_hold`: manual/status-only. The app has no single paid-traffic, creator, gifting, or social-posting integration to block.
- KS-5 `provider_hold`: manual/status-only. Generation routing still relies on route/provenance guards rather than one global provider toggle.
- KS-6 `print_provider_hold`: enforced. `submitPrintAfterOwnerGo` refuses before owner-go lock when active, and `runPrintProduction` also refuses before Lulu/RPI provider submission.

## Validation

- Activating any switch requires nonblank `updatedBy`.
- Activating a switch requires a nonblank reason.
- Switch changes append local history for operator review.
- Existing `HSB_CHECKOUT_PAUSED=true` remains a separate env-level checkout pause and is displayed on the admin page.

## Remaining Manual Risk

Resend bounce monitoring is still not implemented in this slice. Before external paid traffic or creator/gifting traffic, either implement bounce monitoring or record a separate explicit risk acceptance.
