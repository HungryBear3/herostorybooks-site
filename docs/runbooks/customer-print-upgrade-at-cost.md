# Approved-book print purchases at provider cost

Status: draft PR #207 on `feat/owner-print-upgrade-20261014`; CI and Vercel Preview checks pass. **Not deployed to Production, not exercised against Production, and no live Stripe Session or email has been created.** This runbook is the operator contract for the first (owner) test and later eligible approved books.

## What it is

A customer with an approved book receives a private, one-use, expiring link for either a first digital-to-print upgrade or extra copies. On it they:

1. enter the full US shipping address (needed for an exact provider price);
2. see live provider-cost quotes for **both** a softcover and a hardcover at the chosen quantity (print + shipping/handling + provider fulfillment fee + provider tax, no markup, never the retail price difference);
3. pick one and pay exactly that quote on Stripe Checkout (price-locked, idempotent);
4. the signed webhook records the payment and the confirmed address **only**.

Print files are prepared manually **after** the customer has chosen and paid, for the chosen format only. Nothing submits a print job; nothing starts fulfillment; no email is sent automatically.

## Code map

| Concern | Where |
| --- | --- |
| Offer (token hash, expiry, one-use, approved-source evidence, eligibility) | `src/lib/print-upgrade-offer.ts` |
| Quotes (exact cents from Lulu decimal strings, bound to offer, 60-minute TTL) | `src/lib/print-upgrade-quote.ts`, `calculatePrintJobCost` / `createLuluPrintCostQuoteProvider` in `src/lib/lulu.ts` |
| Checkout lock + settlement + expiry | `src/lib/print-upgrade-checkout.ts` |
| HTTP handlers (customer + admin) | `src/lib/print-upgrade-route-handler.ts`, adapters in `src/lib/print-upgrade-route-deps.ts` |
| Routes | `POST /api/order/[orderId]/print-upgrade/{offer,quote,checkout}`, `POST /api/admin/orders/[orderId]/print-upgrade-offer` |
| Webhook | `src/app/api/webhooks/stripe/route.ts` — `metadata.kind === 'print_upgrade_at_cost'` branch (completed + expired) |
| Customer pages | `/upgrade/[orderId]` (chooser, token in `#token=`), `/upgrade/[orderId]/done`, `/upgrade/[orderId]/cancelled` |
| Email draft / gated send | `src/lib/print-upgrade-email.ts` |
| Operator script | `scripts/prepare-print-upgrade-offer.ts` |
| Order fields | `printUpgradeOffer`, `printUpgradeQuotes`, `printUpgradeLock`, `printCopyPurchases[]` (+ existing `printUpgradeStatus` et al.) |

The legacy admin preview route `POST /api/admin/orders/[orderId]/print-upgrade` (retail delta, dry-run only, checkout retired) is unchanged and is **not** used by this flow.

## Eligibility (fail-closed)

An order can be offered / quoted / charged only while paid, not refunded, and not internally disposed. A first `upgrade` additionally requires a digital original and no prior paid upgrade or print job. An `extra_copy` may follow an approved printed book or paid upgrade. In both cases, the offer must match the current approved source/version and presented token (constant-time hash compare), remain unexpired, unrevoked and unconsumed, and have no conflicting open Checkout Session. The customer sees the same 404 for every denial.

## Operator sequence

1. **Verify the approved content.** Confirm the approved digital PDF's SHA-256 and page count for the order. For the owner's test the approved content is the 25-page v5 private-review PDF with SHA-256 `97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38`. This PDF is **not** a print-ready master; it is evidence of what was approved.
2. **Prepare the offer** (no send, no Stripe, no provider):
   ```
   node --experimental-strip-types scripts/prepare-print-upgrade-offer.ts <orderId> \
     --pdf <path-to-approved.pdf> --sha256 97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38 \
     --pages 25 --label "private-review-v5.pdf"
   ```
   or `POST /api/admin/orders/<orderId>/print-upgrade-offer` with the ops key and `{ approvedSourceSha256, approvedSourcePageCount, approvedSourceLabel }`. Both return the one-time chooser URL and the email draft. Only the token **hash** is stored; re-running rotates the token.
3. **Read back the draft**, then send it only after the release and live-price gates below pass. Sending requires `HSB_PRINT_UPGRADE_OFFER_EMAIL_ENABLED=true` and a Resend key; `sendPrintUpgradeOfferEmail` is idempotent per (order, offer). There is deliberately no UI button for sending in this slice.
4. Customer pays. Confirm the signed webhook recorded exactly one `printCopyPurchases[]` receipt for the Session, with the bound kind, quantity, format, source/version, amount and destination. Replayed webhook events must not create another receipt or print job.
5. **Prepare print files for the chosen format only**, from the approved content, through the existing print-readiness / certification gates. Then the existing separately-approved print-go path. The quoted interior page counts are `printUpgradeOffer.quotePageCounts` (softcover 32 / hardcover 26 for a 25-page book — provider minimums, blank end pages); the print interior must match the quoted page count or be re-quoted.

## Stop conditions

- `print_upgrade_settlement_conflict` audit event: money was taken but the facts did not match the lock. Reconcile in Stripe before anything else; never "fix up" the order to match.
- `print_upgrade_quote_unavailable`: the provider could not price; the customer is blocked from paying by design.
- The order is refunded, disposed, or already has a print job.

## Exact remaining live prerequisites

None of these were done in this session (all are owner / production actions):

1. `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET` (+ optional `LULU_API_URL` for sandbox), `LULU_SHIPPING_LEVEL`, `LULU_FALLBACK_PHONE` (real phone; the cost calculation and print job both send it), `LULU_SOFTCOVER_POD_PACKAGE_ID` / `LULU_HARDCOVER_POD_PACKAGE_ID` confirmed for the 8.5×8.5 products actually certified.
2. Stripe: the production webhook endpoint must subscribe to `checkout.session.expired` in addition to `checkout.session.completed` (new for this flow). `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` as today.
3. `HSB_PRINT_UPGRADE_OFFER_EMAIL_ENABLED=true` only when the owner wants the gated send to work.
4. The order record for the owner's existing paid digital order must exist in the production Blob store with `paymentStatus: 'paid'` and `bookFormat: 'digital'`; if it was built outside the app it may be missing fields — run `scripts/order-status.ts <orderId>` first.
5. Run the Lulu cost calculation against the **sandbox** first (`LULU_API_URL=https://api.sandbox.lulu.com`) and compare to the production price before offering a real customer.
6. Deploy the branch; the chooser needs `NEXT_PUBLIC_URL` / `VERCEL_PROJECT_PRODUCTION_URL` for correct `success_url` / `cancel_url`.
7. Determine the site's own sales-tax obligation on the at-cost charge and whether/how Stripe Tax applies; the current code passes through the **provider's** tax only. Keep live payable checkout disabled until this is resolved and the displayed total is accurate.
8. Provide a current, documented production-plus-transit estimate for both offered SKUs/shipping level and configure `HSB_PRINT_DELIVERY_MIN_DAYS` / `HSB_PRINT_DELIVERY_MAX_DAYS`; absent those values, payable checkout remains disabled.

## Residual design notes

- Quote validity 60 min; Stripe Session validity 60 min (Stripe minimum 30, max 24 h). A `provisioning` lock for a different quote blocks for 15 min.
- The shipping address is collected on our private page (the provider needs it to price) and **not** re-collected by Stripe, so quoted and shipped destinations cannot diverge.
- `priceCents` / `settledAmountCents` of the original digital purchase are never rewritten; the upgrade amount lives in `printUpgradeAmountCents` and the lock.

## Additional copies (same approved book)

The same chooser supports a separate `extra_copy` offer, prepared with `--kind extra_copy` or `purchaseKind: "extra_copy"` on the admin route. The recipient selects format, quantity (1–10) and a full US destination. Lulu prices the **entire quantity** for that destination; the resulting quote/Stripe lock binds order, approved-source SHA-256, native proof version when present, format, quantity, destination, exact total and offer. A settled purchase appends a distinct `printCopyPurchases[]` receipt; it does not change the original story or the first print purchase. A replay of an earlier paid Session is a no-op, including after a later extra-copy offer. Each new destination/quantity is a separate offer and payment; no prior shipping address is reused. The copy purchase remains `awaiting_files` and has no print job.

Do not issue a new offer while an earlier Checkout Session is open or provisioning. A revised native proof invalidates a previously issued offer; the print-go helper also requires the current native proof approval and the exact source SHA-256 used to make the print derivative. For legacy/manual approvals such as the owner test, the operator must verify the approved source file SHA-256 separately before print-go. No automatic provider submission is wired to `printCopyPurchases`.

## Delivery estimate gate

Lulu's cost calculation does not by itself attest delivery timing. The quote adapter only attaches estimated dates when `HSB_PRINT_DELIVERY_MIN_DAYS` and `HSB_PRINT_DELIVERY_MAX_DAYS` (calendar days, 1–90) are configured from a current, documented production-plus-transit qualification for the offered SKUs/shipping level. Without both dates the customer can view a cost but **cannot open a payable Checkout Session**. Revalidate these settings if the provider or shipping service changes; the estimate assumes prompt print-proof approval and shifts if approval is delayed. This is a release prerequisite, not a default promise.

The existing NT-20 source-identity test retains its base hash by subtracting only three explicitly fenced additive print-commerce sections in `orders.ts` (new event names, optional fields, and types). Every pre-existing declaration and byte is still compared to the original baseline.
