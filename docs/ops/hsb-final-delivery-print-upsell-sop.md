# HSB final delivery + optional print upgrade SOP

Status: internal standard process. Customer sends, Stripe Checkout creation, payment changes, and print/provider actions remain separately approval-gated.

## Required sequence

1. Bind the final digital PDF to the correct order, customer email, byte size, and SHA-256. Confirm the proof/release gates required for that order are satisfied.
2. Preview the upgrade with the admin print-upgrade route. Preview is the default and must not create a Stripe session, send an email, or contact a print provider.
3. Review the target format, price difference, provider label, recipient, and copy. The price difference comes from the order/catalog pricing source of truth, not a hardcoded campaign price.
4. After explicit approval for that exact order and amount, call the same route with both `createCheckout: true` and `confirmCreateCheckout: true`. This creates only the Stripe Checkout session; it does not send email or start print fulfillment.
5. Build the final digital-delivery email with the private final-PDF URL and the returned checkout URL. The print block must remain optional and state that shipping/tax are additional, digital ownership is unaffected, and printing remains gated by payment, proof approval, print QA, and final print-go review.
6. After explicit approval of the exact recipient, subject, PDF URL, and checkout URL, send one final-delivery email. Read back provider acceptance and record the message identifier.
7. If the customer pays, the Stripe webhook records the print upgrade and shipping address only. It must not trigger fulfillment or provider submission.
8. Run print-readiness/physical-proof gates for the exact paid order. Obtain separate approval before any Lulu/RPI upload, paid proof/order, or production action.

## Stop conditions

- Recipient/order identity is uncertain.
- Final PDF hash or private URL is not verified.
- Upgrade amount, format, shipping/tax treatment, or provider is uncertain.
- A checkout session already exists or the upgrade is already paid.
- Any proof, QA, physical-sharpness, or owner print-go gate remains unsatisfied for provider submission.

## Audit evidence

Retain the final PDF hash, order ID, offer preview, approved amount/format, Stripe session ID, sent-email provider ID, webhook payment evidence, shipping address readback, print-ready artifact hashes, and every later provider job/order ID.
