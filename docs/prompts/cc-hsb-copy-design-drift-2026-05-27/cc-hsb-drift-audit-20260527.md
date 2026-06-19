## Task: Live production drift audit for HeroStoryBooks copy, pricing, and mobile design

## Context
- Repo/worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-drift-audit-20260527`
- Branch: `cc-hsb-drift-audit-20260527`
- Live production: `https://herostorybooks.com`
- Pages to audit: `/`, `/pricing`, `/checkout`, `/samples`, `/terms`, `/privacy`
- Current source baseline: commit `15e94cb` (`fix(hsb): add custom voice-led story direction`)
- Preserve current pricing unless source proves otherwise:
  - Digital PDF: `$14.99`
  - Classic softcover: `$44.99`
  - Premium hardcover: `$64.99`
- Current positioning: proof-first, gift-quality, one-book buyer trust.
- Avoid approving generic SaaS/AI-magic copy, fabricated testimonials/team claims, or refund promises stronger than terms.

## Goal
Produce a read-only audit report that compares live production to the expected HSB trust/pricing/product stance and identifies any drift across pricing, product labels, CTA labels, trust copy, family/pet/voice copy, legal pages, and mobile design.

## Steps
1. Do not edit source files except for audit artifacts under `docs/tmp/hsb-copy-design-drift-2026-05-27/`.
2. Inspect the six live production pages with Playwright or an equivalent browser tool at desktop width and mobile widths `390px` and `320px`.
3. Capture screenshots for each audited route and viewport where useful. Save under:
   `docs/tmp/hsb-copy-design-drift-2026-05-27/audit-screenshots/`
4. Check live HTML/text for:
   - price mismatches against `$14.99`, `$44.99`, `$64.99`
   - old price strings: `$39.99`, `$59.99`, `$19.99`, `$29.99`
   - stale product labels: `Basic`, `Deluxe`
   - stale availability/copy: `Coming Soon`, `AI magic`, unsupported `instant` claims
   - old voice deletion copy stronger than manual deletion-on-request
   - refund/shipping/proof promises stronger than `/terms`
   - generic SaaS/team/testimonial claims not backed by visible product evidence
5. Compare live visible labels and CTA text across homepage/pricing/checkout/samples.
6. Check mobile layout at `320px` and `390px` for horizontal overflow, cramped CTAs, hidden product context, first-viewport clarity, and proof/sample visibility.
7. Save a concise markdown report at:
   `docs/tmp/hsb-copy-design-drift-2026-05-27/live-production-drift-audit.md`

## Verification
- [ ] No production deploy.
- [ ] No source/code changes outside `docs/tmp/hsb-copy-design-drift-2026-05-27/`.
- [ ] Screenshots saved with route and viewport in the filename.
- [ ] Report includes verdict, findings table, evidence links/paths, and residual risks.

## Out of Scope
- Do not change code, copy, tests, pricing, Stripe, Lulu, emails, env vars, database/blob data, or production deployment.
- Do not run checkout payment flows past Stripe Checkout creation if a link appears.
- Do not mutate customer/order/admin state.

## Commit
No commit required unless only audit artifacts changed and committing them helps the requester collect results. If committing, use:
`docs(hsb): add copy design drift audit artifacts`
