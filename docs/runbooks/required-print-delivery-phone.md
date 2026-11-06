# Required print delivery phone

Retail Classic softcover and Premium hardcover checkout collect the shipping address, recipient name and delivery phone at Stripe-hosted secure payment. The local checkout form asks for email and explains the hosted collection; it has no phone input or phone payload. Digital checkout does not request shipping or phone collection.

At-cost print upgrades and extra copies collect the destination and recipient on the private chooser to obtain a quote. Stripe Checkout collects the phone without re-collecting that quoted destination. Settlement records a purchase receipt; it does not submit print or start fulfillment.

## Private contact authority

Recipient name and phone live in `print-contact-store.ts`, separately from public Order JSON. The private store uses the validated `HSB_PRIVATE_READ_WRITE_TOKEN`, explicitly distinct from the public order Blob store identity. It has no public-token or local-storage fallback. A namespace-prefixed record under `private-contact/orders/<orderId>/sessions/<sessionId>.json` binds order, purchase kind, Stripe Session, PaymentIntent, quote (when applicable), and destination. Intended recipients for new at-cost quotes are stored privately before those quotes commit.

Signed webhook settlement first preserves durable payment evidence, then captures private contact. Both legacy `shipping_details` and current `collected_information.shipping_details` are supported, with the former used when present. Recipient name comes only from shipping details; phone comes from `customer_details.phone`. Payer and child names and embedded shipping-phone fields are not substitutes. The phone normalizer accepts supported numeric formatting and produces E.164; annotations or invalid/missing values become missing contact. Records are strictly parsed and create-only. An exact replay is safe; conflicting contact or binding is refused. A contact storage error returns a retryable webhook failure while retaining payment evidence.

Legacy retail-delta upgrades bind through their dedicated signed settlement receipt and matching audit event. Later at-cost copy purchases have separate receipts and cannot replace the original contact authority.

## Operational hold

Physical print release requires a complete, matching private recipient and phone. Missing contact, missing recipient, missing phone, binding mismatch or unavailable private storage refuses before the print claim, cover work or provider submission. The order remains at `proof_ready`; successful payment or a quote phone placeholder is insufficient authority. Keep the shipment on hold and have the authorized operator review the contact status and payment evidence. Do not put recipient name or phone into public Order shipping fields, logs, analytics or shared DTOs. This runbook does not authorize record repair or historical backfill.

At the irreversible submission boundary the existing paid/proof/refund and contact-binding fences still apply. Lulu receives the resolved private recipient, destination and exact validated phone, never the child's name or a fallback number.

## Authorized display and quote limitation

The authenticated admin detail page and `GET /api/admin/orders/<orderId>/print-contact` display private contact separately from shared order projections. The endpoint authenticates before reading and returns `Cache-Control: private, no-store, max-age=0`; unauthorized requests reveal no contact. Missing or mismatched records have explicit statuses, not invented values.

The current Lulu cost calculation uses `LULU_FALLBACK_PHONE ?? '000-000-0000'`. It does not validate that quote fallback. Quote fallback validation is deferred; the quote's number is never physical delivery authority. `src/lib/lulu.ts` and its cost-calculation tests are unchanged by this carry. This document adds no retention, pricing, default-tier or commercial policy.
