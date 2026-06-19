## Task: HeroStoryBooks design punch list for proof-first buyer trust

## Context
- Repo/worktree: `/Users/abigailclaw/.openclaw/workspace/cc-worktrees/cc-hsb-design-punch-20260527`
- Branch: `cc-hsb-design-punch-20260527`
- Live production: `https://herostorybooks.com`
- Base: commit `15e94cb` (`fix(hsb): add custom voice-led story direction`)
- Current pricing:
  - Digital PDF: `$14.99`
  - Classic softcover: `$44.99`
  - Premium hardcover: `$64.99`
- Current direction: proof-first, gift-quality, one-book buyer trust.
- Avoid generic SaaS/AI-magic copy, fabricated testimonials/team claims, and refund promises stronger than terms.

## Goal
Create a mostly read-only design punch list for HSB production and current source. Patch only tiny obvious defects that are low-risk and directly improve clarity or prevent layout breakage. Otherwise report recommendations without editing.

## Review Focus
- First viewport: does it immediately show a personalized book/proof/gift-quality signal?
- Proof assets: are sample/proof visuals prominent enough before commitment?
- Print trust: does the page make softcover/hardcover value understandable without overpromising?
- CTA clarity: do CTA labels match the proof-first one-book buyer journey?
- Mobile at `320px` and `390px`: no horizontal overflow, no clipped CTAs, no text overlap, no hidden critical pricing/product context.
- Generic SaaS drift: avoid vague AI/productivity/team language.
- Voice/family/pet copy: clear, parent-controlled, no unsupported deletion or voice-clone promises.

## Steps
1. Inspect live production pages `/`, `/pricing`, `/checkout`, `/samples` at desktop plus `390px` and `320px`.
2. Inspect active source for first-viewport and pricing/CTA components.
3. Save screenshots where they support punch-list items under:
   `docs/tmp/hsb-copy-design-drift-2026-05-27/design-screenshots/`
4. Patch only tiny obvious issues, such as a typo, a clipped label, or one inconsistent CTA. Do not do a redesign.
5. Save the punch list at:
   `docs/tmp/hsb-copy-design-drift-2026-05-27/design-punch-list.md`

## Verification
- [ ] If no source changed, state read-only.
- [ ] If source changed, run the narrow relevant test/build check for the touched area.
- [ ] Do not deploy.
- [ ] Include severity, evidence screenshot/path, recommendation, and whether it should block launch/traffic.

## Out of Scope
- No production deploy, no Stripe/Lulu/email/social/database mutations, no secrets/env changes.
- No broad redesign or new visual system.
- No image-generation/product pipeline changes.

## Commit Message
Only if tiny source/docs changes are made:
`fix(hsb): polish proof-first design copy`
