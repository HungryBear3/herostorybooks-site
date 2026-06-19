## Task: Patch stale active HeroStoryBooks copy strings

## Context
- Repo/worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-stale-copy-20260527`
- Branch: `cc-hsb-stale-copy-20260527`
- Base: commit `15e94cb` (`fix(hsb): add custom voice-led story direction`)
- Current pricing that must be preserved:
  - Digital PDF: `$14.99`
  - Classic softcover: `$44.99`
  - Premium hardcover: `$64.99`
- Current direction: proof-first, gift-quality, one-book buyer trust.
- Avoid generic SaaS/AI-magic copy, fabricated testimonials/team claims, and refund promises stronger than terms.
- HSB image generation policy: subscription GPT workflow for current samples; do not add image-pipeline/product code.

## Goal
Find and patch stale active source, tests, and current docs strings that conflict with current HSB pricing, product labels, proof-first trust stance, and voice-retention stance. Keep the patch narrow.

## Stale Strings to Sweep
- Prices: `$39.99`, `$59.99`, `$19.99`, `$29.99`
- Product labels: `Basic`, `Deluxe`
- Availability/generic claims: `Coming Soon`, `AI magic`, unsupported `instant`
- Old voice deletion or retention copy that implies automatic deletion after ship if the backing deletion behavior does not exist
- Unsupported refund, shipping, proof, or delivery promises stronger than terms

## Steps
1. Use `rg` first. Separate active source/tests/current docs from archival docs, old reports, screenshots, build output, and generated artifacts.
2. Patch only active source, tests, and current docs that would affect product behavior, generated emails, visible pages, or verification.
3. Do not churn archival records or historical reports unless they are imported/served as current UI copy.
4. Preserve the current product names and prices:
   - Digital PDF `$14.99`
   - Classic softcover `$44.99`
   - Premium hardcover `$64.99`
5. Keep copy proof-first and concrete. Prefer phrases like proof, printed keepsake, gift-quality, parent review, manual deletion request.
6. Do not add or change image-generation provider code.
7. Add or update focused tests only where an existing pattern covers the touched strings.

## Verification
- [ ] `rg` no longer finds stale strings in active source/tests/current docs, except documented false positives.
- [ ] Run the narrow relevant tests first.
- [ ] Run `npm test` if the patch touches shared pricing, checkout, order, email, or generated copy.
- [ ] Do not deploy.
- [ ] Save a summary at `docs/tmp/hsb-copy-design-drift-2026-05-27/stale-copy-lane-summary.md` with changed files, tests, and any false positives left.

## Out of Scope
- No production deploy, no Stripe/Lulu/email/social/database mutations, no secrets/env changes.
- No broad landing-page redesign.
- No archival-doc cleanup for its own sake.
- No image-pipeline/product code.

## Commit Message
`fix(hsb): remove stale active copy and pricing strings`
