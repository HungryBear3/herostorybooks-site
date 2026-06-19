# HSB production buyer-path audit — 2026-05-27

Scope: low-risk review only. No Stripe payment, no test checkout session, no Lulu/print API action, no customer data reads.

## Surfaces checked

- Live production GET/browser smoke:
  - `https://herostorybooks.com/` → 200
  - `https://herostorybooks.com/pricing` → 200
  - `https://herostorybooks.com/checkout?format=digital` → 200
  - `https://herostorybooks.com/fathers-day` → 200
  - `https://herostorybooks.com/thank-you` without order id → 200 neutral payment-confirming state
  - fake `/status/...` and `/review/...` → 404, as expected for unknown orders
- Source reviewed:
  - `src/app/checkout/checkout-form.tsx`
  - `src/app/thank-you/page.tsx`
  - `src/app/status/[orderId]/page.tsx`
  - `src/lib/order-status-view.ts`
  - `src/app/review/[orderId]/review-client.tsx`
  - `src/app/review/[orderId]/page.tsx`
  - `src/lib/order-email.ts`
  - `src/lib/pricing.ts`
- Tests run:
  - `npm test -- --runInBand tests/order-email.test.ts tests/order-status-view.test.ts tests/checkout-flow.test.ts tests/stripe-checkout.test.ts tests/thank-you-page.test.ts tests/proof-ack-invalidation.test.ts tests/audit-trail.test.ts`
  - Repo script expanded to the full suite; result: **790 passed / 0 failed**.

## Buyer path findings

### Checkout copy

Good:
- Checkout leads with story/hero, then format, email, photo, voice.
- Checkout clearly says: “Nothing prints until you say so.”
- Digital offer is live as the Father’s Day pick at `$14.99`.
- Digital copy says: “32-page high-res PDF delivered after you approve · No printing or shipping step.”
- Photo upload copy allows starting without a photo but states production will not begin until a photo is provided.
- Failed pre-payment submit errors are inline and explicitly say the buyer has not been charged.

Checked:
- **Softcover price confirmed:** production checkout/pricing/home show Classic softcover at `$44.99`; Alexy confirmed `$44.99` is correct on 2026-05-27. Not a blocker.

### After paying / thank-you

Good:
- Thank-you page does **not** trust URL params. It fetches the order and only shows success when `paymentStatus === 'paid'`.
- Unknown/no order id shows neutral “Confirming your payment…” copy, not fake success.
- Paid success copy says order is saved, digital proofs are usually ready within 2 business days, print follows after approval, and links to `/status/{orderId}`.

Risk:
- I did not run a real payment/session, per instruction. So this confirms code/live surface behavior, not actual Stripe webhook timing or real email arrival.

### Order confirmation email

Good:
- Confirmation subject: `<child>'s Hero Story Books order is in`.
- Includes child name, format, delivery expectation, order id, support email.
- Print confirmation says digital preview arrives first before it prints.
- Text version includes a `/status/{orderId}` tracking link.

Risk / blocker:
- **HTML confirmation email has no visible status button/link.** Only the text version includes `Track your order: .../status/{id}`. Many buyers will read the HTML email, so post-payment confidence would be stronger with a visible “View order status” CTA in the HTML confirmation.
- Production has `HSB_EMAIL_FROM`, `HSB_SUPPORT_EMAIL`, and `RESEND_API_KEY` envs present. I did not send a live email, so sender-domain deliverability/verification is not proven by this audit.

### Proof-ready / review / approval

Good:
- Proof-ready email is strong: primary CTA goes to `/review/{orderId}?token=...`, explains every illustrated page, full proof PDF, changes, and approve-before-print.
- Review page is token-gated for print orders when a proof token exists.
- Review page forces a conservative sequence:
  1. open full proof PDF,
  2. accept each illustrated page,
  3. acknowledge full proof was reviewed,
  4. confirm approval in modal.
- Server tests enforce that `approveWholeBook` is the only path setting `reviewStatus=approved` and rejects missing proof, missing ack, or unaccepted pages.

Risk / blocker:
- **Status page proof-ready CTA points to the raw proof PDF, not the review/approval URL.** In `buildOrderStatusView`, `proof_ready` sets `primaryAction.href = order.storyArtifactUrl` and label `View Proof`. If a buyer comes back through the thank-you/status path instead of the proof-ready email, they can view the PDF but cannot approve from that CTA. That creates a real post-payment loop risk: “I saw the proof, how do I approve?”

## Verdict

Not blocked for quiet/manual orders, but I would not push Father’s Day harder until these are resolved:

1. Add HTML confirmation-email CTA to `/status/{orderId}`.
2. Change status page `proof_ready` CTA to the review/approval route when `proofApprovalToken` exists; keep raw PDF as secondary/fallback.

No Stripe/Lulu/payment actions were taken.
