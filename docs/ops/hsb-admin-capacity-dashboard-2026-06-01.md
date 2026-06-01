# HSB Admin Capacity Dashboard

Status: implemented locally on branch `cc-hsb-awaiting-qa-20260531`; read-only only. No production deploy, order mutation, Stripe/Lulu/RPI action, payment action, or customer communication was performed.

## Route

- `/admin/capacity`
- Uses existing `HSB_ORDER_ADMIN_KEY` admin cookie flow.
- Reads orders via existing `listOrders()`.

## Metrics

- Paid today: paid orders whose order record was created on the current `America/Chicago` day.
- QA in-flight: orders with `fulfillmentStatus === 'awaiting_qa'`.
- Oldest proof age: oldest awaiting-QA order, using `proof_generated` / `proof_rebuilt` audit time when present, otherwise `updatedAt` / `createdAt`.
- Median time-to-proof: elapsed time from order creation to `qaPassAt` or `qa_pass_recorded` audit event, when available.
- Revision round-trips: max page `regenerateCount` or revision audit request count.
- Rolling QA defect rate: latest 5 paid orders with explicit local defect signals such as `targetedRegenNeeded`, page changes requested, or approval rejected audit events.
- Print ack delay: local order records stuck in `submitting_to_print` for more than 24 hours with no `printJobStatus`.

## Limits

- Stripe disputes are not represented in `OrderRecord`, so the dashboard explicitly marks that signal as unavailable and requires manual Stripe verification.
- External Lulu/RPI provider truth is only reflected if the order record has been updated. Use provider dashboards/logs for final go/no-go.

## Operational Rule

- Target: 8 paid orders/day.
- Hard ceiling: 10 paid orders/day.
- Manual pause action remains `HSB_CHECKOUT_PAUSED=true`.
