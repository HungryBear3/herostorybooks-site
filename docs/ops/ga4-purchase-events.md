# GA4 purchase events

> **Current truth:** the purchase is sent only from the signed webhook's
> durable pending → paid transition (a replay never re-sends it), only on a
> production deployment, with bounded attribution — see
> `src/lib/purchase-analytics.ts`. The event contract, GA4 Admin checklist and
> transaction-id readback live in `docs/analytics/README.md`. Anything below
> that conflicts (Preview sends, replay dedup) is superseded.

HSB emits GA4's recommended `purchase` event from the signed Stripe webhook,
after the durable order/payment write. The event uses Stripe's Checkout Session
ID as `transaction_id`, allowing GA4 to deduplicate webhook replays. The
anonymous GA client ID is captured at checkout and carried in Stripe metadata
so the server-verified purchase remains attached to the originating GA session.
If it is unavailable, a transaction-derived fallback keeps revenue measurable
without collecting identity data. Amount,
currency, and product format come from server-side Stripe/order records; names,
email, addresses, uploaded media, and other customer data are never sent.

Required Production and Preview environment variables:

- `GA4_MEASUREMENT_ID` (the existing `NEXT_PUBLIC_GA_MEASUREMENT_ID` is also
  accepted as the measurement-ID fallback)
- `GA4_API_SECRET` (create under GA4 Admin → Data streams → Measurement Protocol
  API secrets; never expose it through a `NEXT_PUBLIC_` variable)

If either variable is absent, the event no-ops. Delivery is deferred until after
the webhook response and failures are warning-only, so analytics cannot block a
payment, confirmation, or fulfillment. Validate with GA4 DebugView/Realtime
using a test-mode paid Checkout Session before promoting the environment change.
