# GA4 purchase events

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

## Meta Conversions API sibling (candidate, disabled)

`scheduleMetaCapiPurchase` (`src/lib/marketing/meta-capi.ts`) sits beside every
`scheduleGa4Purchase` call in the same webhook, and behaves the same way: deferred
past the response, bounded timeout, failures swallowed. It is disabled unless
`META_CAPI_ENABLED`, `META_CAPI_DATASET_ID`, and `META_CAPI_ACCESS_TOKEN` are all
set, and it sends no order, customer, or session identifier — only a hashed dedupe
pseudonym. See `docs/marketing/meta-measurement-candidate.md` before enabling it.
