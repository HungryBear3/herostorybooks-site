# HSB Checkout Audit — 2026-05-27

Scope: read-only/static + safe live smoke. No paid order, no Stripe Checkout Session, no fulfillment, no Lulu action.

## Commands / checks run

- Live GET smoke:
  - `https://herostorybooks.com/`
  - `https://herostorybooks.com/checkout`
  - `https://herostorybooks.com/pricing`
  - `https://herostorybooks.com/thank-you?orderId=ord_nonexistent_audit&childName=Audit&format=Digital%20PDF&email=audit%40example.com`
- Safe live API POST smoke with missing/invalid required fields only:
  - Missing theme returned `400 {"error":"Missing required field: theme_required","code":"theme_required"}`.
  - All visible required fields except pronouns + invalid email returned `400 {"error":"Missing required field: pronouns_required","code":"pronouns_required"}`.
- Browser checkout visual smoke at `https://herostorybooks.com/checkout`.
- Source review:
  - `src/app/checkout/checkout-form.tsx`
  - `src/app/api/order/route.ts`
  - `src/app/api/webhooks/stripe/route.ts`
  - `src/app/thank-you/page.tsx`
  - `src/lib/pricing.ts`
  - checkout / Stripe / order / fulfillment tests.
- Test run: `npm test -- --runInBand tests/checkout-flow.test.ts tests/stripe-checkout.test.ts tests/order-route-required-fields.test.ts tests/voice-upload.test.ts tests/pricing.test.ts tests/orders.test.ts tests/fulfillment.test.ts --verbose`
  - Because package script expands `tests/*.test.ts`, this executed the full suite.
  - Result: `790 pass, 0 fail`.

## Findings

### P0 — live checkout appears blocked by client/server contract drift

- Live checkout page does **not visibly expose** the hero pronouns field in the browser snapshot.
- Live disabled CTA copy after selecting story/format/name/email still listed only: `format · skin tone · hair` or `skin tone · hair`.
- Live API requires `childPronouns` before it will proceed:
  - Safe POST with theme, childName, skinTone, hairStyle, and bookFormat but no pronouns returned `pronouns_required` before email validation.
- Risk: if the deployed client does not submit `childPronouns`, real customers cannot create a Stripe Checkout Session even after filling all visible fields.
- Current local source **does** include a required Hero pronouns select, so production is likely stale or serving an older checkout bundle than the API contract.

Recommended fix:
1. Deploy the checkout client containing the Hero pronouns field, or temporarily make API pronouns backward-compatible.
2. Add an e2e/static contract test that the rendered checkout page includes `Hero pronouns` whenever `missingRequiredField`/API requires pronouns.
3. Re-smoke live checkout after deploy with an invalid email/no-payment POST shape to confirm no `pronouns_required` drift.

### P1 — pricing conflicts with locked launch memory

- Live checkout and current tests show:
  - Digital: `$14.99`
  - Softcover/classic: `$44.99`
  - Hardcover/premium: `$64.99`
- Persistent HSB pricing memory says locked pricing is `$14.99 digital / $39.99 softcover / $64.99 hardcover`.
- Current `tests/pricing.test.ts` asserts `$44.99` for classic, so repo and live are internally consistent but conflict with the remembered locked price.

Recommended fix:
- Confirm intended softcover price. If locked price remains `$39.99`, update `src/lib/pricing.ts`, checkout `FORMATS`, order pricing source, and tests in one commit.

### P1 — page-count copy is inconsistent/confusing

- Live format cards advertise `32-page` digital/softcover/hardcover.
- Sidebar initially shows `Pages: 24` before format selection.
- Source/tests indicate digital/classic generate 24 story pages and premium 32; pricing features say `24 illustrated story pages plus keepsake pages`.
- This needs customer-facing reconciliation: either say `24 illustrated story pages plus keepsake pages` everywhere, or clearly define total physical page count vs story pages.

### P2 — order summary formats price oddly in accessible text

- Browser text extraction for selected digital showed `Total $14.99.00`.
- Visible UI may be acceptable, but accessible/text representation is malformed enough to confuse screen readers or scraped QA.
- Inspect rendered markup/CSS around `totalPrice`; source currently renders `selectedFormat.price`, so this may be an artifact of nearby hidden text/formatting. Needs browser check after pronouns drift is fixed.

## Positive controls

- `/checkout` returns 200 and renders the checkout form.
- `/pricing` returns 200.
- `/thank-you` with nonexistent order returns a safe pending confirmation state, not a false paid/success state.
- `/api/order` fails closed on missing required fields before order/Stripe session creation.
- Order route persists order/photo/voice before Stripe session creation and aborts pre-Stripe on durable persistence errors.
- Stripe success URL is canonicalized for production and preview-safe for non-production.
- Webhook tests cover payment update/fulfillment replay/refund replay behavior.
- Full test suite: 790 passing.

## Safety boundary

No valid order POST was sent. No Stripe Checkout Session was created. No payment, fulfillment, print, email, or deploy action was triggered.
