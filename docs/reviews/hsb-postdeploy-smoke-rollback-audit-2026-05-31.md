# HSB Post-Deploy Smoke + Rollback Audit

Audit time: 2026-05-31 19:36 CDT / 2026-06-01 00:36 UTC  
Worker: Worker 2  
Deployment under audit: `dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD`  
Production domains: `https://herostorybooks.com`, `https://www.herostorybooks.com`  

## Verdict

PASS with residual risk.

The production deployment is Ready, apex/www serve live pages, `/checkout` shows the proof-approval shipping copy, and the old bad print-card copy `Digital PDF included` is absent from the rendered checkout on both apex and www. Source and focused tests confirm Stripe Checkout sessions are created with `allow_promotion_codes: true`.

No order, payment, Stripe Checkout Session, Lulu/RPI action, customer mutation, or email/contact action was performed during this audit.

## Checks Run

Live HTTP / browser checks:

```bash
curl -sSIL --max-time 20 https://herostorybooks.com/
curl -sSIL --max-time 20 https://www.herostorybooks.com/
curl -sSIL --max-time 20 https://herostorybooks.com/checkout
curl -sSIL --max-time 20 https://www.herostorybooks.com/checkout
node - <<'NODE' # Playwright rendered-text smoke for /, /checkout, /samples, /privacy, /terms, apex + www checkout
node - <<'NODE' # Playwright rendered-text smoke for deployment URL
node - <<'NODE' # Playwright rendered-text smoke for prior Ready deployment rollback candidate
```

Vercel read-only checks:

```bash
vercel inspect dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD
vercel alias ls
vercel ls herostorybooks-site --prod
vercel inspect https://herostorybooks-site-k4uyk99y0-alexy-kapluns-projects.vercel.app
vercel inspect https://herostorybooks-site-2tko6de96-alexy-kapluns-projects.vercel.app
```

Focused local tests:

```bash
node --experimental-strip-types --test tests/stripe-checkout.test.ts tests/checkout-pause.test.ts
```

Result: 13/13 passed. Node emitted only the existing `MODULE_TYPELESS_PACKAGE_JSON` warning.

## Findings

### Production Deploy / Aliases

- `vercel inspect dpl_GUYrKvTpjDKW2gQBumTktTTrjHQD` reports deployment `herostorybooks-site-eg0cg66gn-alexy-kapluns-projects.vercel.app`, target `production`, status `Ready`, created 2026-05-31 19:15:23 CDT.
- `https://herostorybooks.com/` returned HTTP 200 from Vercel.
- `https://www.herostorybooks.com/` returned HTTP 200 from Vercel.
- `https://herostorybooks.com/checkout` returned HTTP 200 from Vercel.
- `https://www.herostorybooks.com/checkout` returned HTTP 200 from Vercel.
- Rendered page smoke returned HTTP 200 for:
  - `https://herostorybooks.com/`
  - `https://herostorybooks.com/checkout`
  - `https://herostorybooks.com/samples`
  - `https://herostorybooks.com/privacy`
  - `https://herostorybooks.com/terms`
  - `https://www.herostorybooks.com/`
  - `https://www.herostorybooks.com/checkout`
- Direct deployment URL smoke returned HTTP 200 for `/` and `/checkout`.

### Checkout Copy

Rendered checkout text on both apex and www includes:

- `Softcover ships 5–7 business days after proof approval`
- `Hardcover ships 5–7 business days after proof approval`
- `You approve the proof before print`

Rendered checkout text on both apex and www does not include:

- `Digital PDF included`
- `Digital instant`
- `15 minutes`
- `Mother’s Day`
- `Mother's Day`

Direct deployment URL `/checkout` also includes proof-approval shipping copy and does not include `Digital PDF included`.

### Promotion-Code Support

Source path:

- `src/app/api/order/route.ts:362` calls `stripe.checkout.sessions.create`.
- `src/app/api/order/route.ts:370` sets `allow_promotion_codes: true`.
- `tests/stripe-checkout.test.ts` includes a source assertion for `allow_promotion_codes: true`.

Focused test result:

- `node --experimental-strip-types --test tests/stripe-checkout.test.ts tests/checkout-pause.test.ts` passed 13/13.

Important boundary: this audit did not create a live Stripe Checkout Session, because that would require going down the live order path and could create customer/order state. The hosted Stripe promo-code field was therefore not visually exercised in a live session.

### Pause Surface

Live `/checkout` is not paused right now; rendered checkout did not show `Queue full for today` or checkout-paused copy.

Source/test evidence:

- `src/lib/checkout-pause.ts` treats `HSB_CHECKOUT_PAUSED=true` as the pause switch.
- `src/app/checkout/page.tsx` is `force-dynamic`, checks `isCheckoutPaused()`, and renders the pause surface instead of `CheckoutForm`.
- `src/app/api/order/route.ts` checks `isCheckoutPaused()` before `await request.formData()` and before `stripe.checkout.sessions.create`.
- `tests/checkout-pause.test.ts` verifies the page gate, API pre-Stripe gate, pause code, and queue-full copy.

The production pause switch was not toggled because that would mutate production behavior.

## Rollback Notes

Nearest prior Ready production deployment discovered:

- `dpl_Gn9Ph4TLsdLJNJwx2DhEPArawadq`
- URL: `https://herostorybooks-site-k4uyk99y0-alexy-kapluns-projects.vercel.app`
- Created: 2026-05-31 18:27:47 CDT
- Status: Ready

One older Ready production deployment also inspected:

- `dpl_2Qp1oCWyezcZWhJz6FBitwQwQQgH`
- URL: `https://herostorybooks-site-2tko6de96-alexy-kapluns-projects.vercel.app`
- Created: 2026-05-31 18:22:34 CDT
- Status: Ready

Rollback command shape if production must be re-aliased:

```bash
vercel alias set herostorybooks-site-k4uyk99y0-alexy-kapluns-projects.vercel.app herostorybooks.com
vercel alias set herostorybooks-site-k4uyk99y0-alexy-kapluns-projects.vercel.app www.herostorybooks.com
```

Rollback caveat: the nearest prior Ready deployment is not a clean content fallback for this release. Its rendered `/checkout` still contains `Digital PDF included` and does not contain the new proof-approval shipping strings. If the problem is order intake capacity, promo uncertainty, or checkout trust copy, prefer pausing checkout with `HSB_CHECKOUT_PAUSED=true` over rolling back to that deployment. Use rollback only for a hard outage/regression where restoring the old deployment is more important than preserving the copy/promo fixes.

Pause switch guidance:

- Set `HSB_CHECKOUT_PAUSED=true` in production Vercel env to close new checkout starts.
- Confirm `https://herostorybooks.com/checkout` shows `Queue full for today`.
- Confirm `/api/order` returns the checkout-paused response before form parsing or Stripe Checkout creation.
- Unset or set false only after capacity/QA operator is ready.

## Residual Risks

- No live Stripe Checkout Session was created, so the live hosted Stripe promo-code field was not visually confirmed. Evidence is source + tests + deployment readiness only.
- `vercel inspect` did not list custom domains under the deployment alias section, but direct apex/www HTTP and rendered smoke checks confirm the domains serve the deployment content.
- Current worktree is already dirty from the deployed checkout/QA edits; this audit did not revert or normalize those changes.
- Nearest prior Ready deployment is available for outage rollback but reintroduces the old checkout copy problem.

## Follow-Up

- If a non-mutating way to inspect an already-created live Checkout Session for this deployment exists, use it to confirm the Stripe promo entry field without creating a new order/session.
- If rollback readiness matters for this release, create or preserve a post-fix Ready deployment as a clean rollback target before the next traffic push.
