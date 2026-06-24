## Task: Align HeroStoryBooks product, checkout, order, thank-you, admin, email, and tests

## Context
- Repo/worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-consistency-20260527`
- Branch: `cc-hsb-consistency-20260527`
- Base: commit `15e94cb` (`fix(hsb): add custom voice-led story direction`)
- Current pricing that must be preserved:
  - Digital PDF: `$14.99`
  - Classic softcover: `$44.99`
  - Premium hardcover: `$64.99`
- Current direction: proof-first, gift-quality, one-book buyer trust.
- Avoid generic SaaS/AI-magic copy, fabricated testimonials/team claims, and refund promises stronger than terms.
- HSB image generation policy: subscription GPT workflow for current samples; do not add image-pipeline/product code.

## Goal
Make active product names, prices, Stripe metadata/session copy, checkout/order/thank-you/admin/email/test copy, and trust stance agree with the current HSB offer. Patch focused inconsistencies only.

## Areas to Inspect
- Homepage/pricing/checkout/samples product cards and CTA labels
- `src/lib/pricing.ts` and any pricing constants/helpers
- Checkout flow and order route metadata
- Stripe Checkout session line item names/descriptions/metadata
- Order confirmation/thank-you/admin-facing labels
- Email copy in `src/lib/order-email.ts` or related modules
- Tests that lock product labels/prices/trust copy

## Steps
1. Map current active product/package names and prices from source.
2. Trace where those values appear in checkout, Stripe metadata, order records, thank-you/admin/email copy, and tests.
3. Patch only inconsistencies that can confuse a buyer or operator.
4. Preserve:
   - Digital PDF `$14.99`
   - Classic softcover `$44.99`
   - Premium hardcover `$64.99`
5. Keep trust copy proof-first and concrete. Do not invent new guarantees.
6. If existing tests cover pricing/checkout/order/email, add or update focused assertions.

## Verification
- [ ] Run focused pricing/checkout/order/email tests relevant to touched files.
- [ ] Run `npm test` if shared flow files are changed.
- [ ] No production deploy.
- [ ] Save a summary at `docs/tmp/hsb-copy-design-drift-2026-05-27/consistency-lane-summary.md` with changed files, tests, and unresolved questions.

## Out of Scope
- No production deploy, no Stripe/Lulu/email/social/database mutations, no secrets/env changes.
- Do not create real Stripe Checkout sessions against production.
- Do not touch image-generation provider/product code.
- Do not redesign the landing page.

## Commit Message
`fix(hsb): align product copy across checkout surfaces`
