# HSB Design Export Scan Plan - 2026-06-23

Scope: internal design ingestion and deploy-candidate planning only. This packet does not approve a push, preview deploy, production deploy or alias, proof release, customer message, order mutation, payment/refund/coupon change, print/provider action, or public/social action.

## Source Artifacts

Current source exports:

- `/Users/abigailclaw/Downloads/Expansion Moments (standalone)-2.html`
- `/Users/abigailclaw/Downloads/HSB Content Approval Board (standalone)-3.html`

Reference-only older exports:

- `/Users/abigailclaw/Downloads/Expansion Moments (standalone).html`
- `/Users/abigailclaw/Downloads/HSB Content Approval Board (standalone)-2.html`
- `/Users/abigailclaw/Downloads/HSB Content Approval Board (standalone).html`

## Normalized Diff Findings

The standalone files include wrapper code, bundled fonts, image assets, and compressed script resources. Raw checksums are useful for identity, but not enough for product meaning.

- `Expansion Moments (standalone)-2.html` and the June 18 `Expansion Moments (standalone).html` differ at the raw file level, but the extracted template source is identical after resource-id normalization. The meaningful CD-3 component code is in compressed bundled resources.
- `HSB Content Approval Board (standalone)-3.html` and `HSB Content Approval Board (standalone)-2.html` normalize to the same extracted source. The oldest no-suffix approval-board file is behind the later two.
- Treat the June 23 files as current source artifacts, but do not assume every byte-level change is a product change.

## Expansion Moments

Intent: a reusable, gentle growth-loop CTA module for moments where the family is already engaged.

Safe-now concepts:

- Private contributor invite: Grandma or another family member can add a memory, dedication, photo, or voice note as draft input only.
- Sibling edition: starts a fresh, separate draft using the current style/story context. Nothing prints.
- Cousin book: starts a blank draft for another child. No order and no payment.
- Save idea / add memory: saves or reopens draft input. No fulfillment and no public surface.

Future-gated concept:

- Gift copy: the design explicitly gates this behind `giftCopyEnabled && printFulfillmentGreen`. When closed, it renders as coming soon. When open, it routes to the normal approval-gated order flow. It must still make no shipping, arrival, auto-print, or auto-send promise.

Blocked claims:

- Auto proof release.
- Any CTA that implies sending to print.
- Shipping or delivery date promises.
- Public share sheets, galleries, feeds, or pass-around discounts.

Recommended implementation posture:

- Do not place CD-3 on public marketing yet.
- Do not add the gift-copy live action yet.
- Safe first slice, when approved: add an internal or preview-only reusable `ExpansionMomentCard`/`ExpansionCtaButton` component with gate defaults closed and tests that forbid blocked copy.
- Most likely safe host later: thank-you/order-complete or story-confidence surfaces, but only for private draft/invite actions that do not touch payment, fulfillment, proof release, or print.

## Content Approval Board

Intent: internal creative review and social/content QA, not public marketing.

Useful product rules:

- Creative approval is separate from posting approval.
- The board must never post, schedule, boost, DM, or email.
- `readyForQueuePrep` is a handoff marker only.
- Server-side rules must enforce blocked, held, rejected, and clearance states. The UI is advisory.
- Static TikTok placements are blocked because TikTok requires a real MP4.
- Discount/promo language is blocked from creative review.
- Proof-style assets require confirmation that only placeholder/sample data is used.
- Real customer/family proof assets require explicit clearance.
- Hold and reject decisions require reasons and audit history.
- Clearance locks approval until Abigail clears it.

Recommended implementation posture:

- Keep this as an internal/admin planning surface, not a public route.
- Do not combine it with `/samples`.
- Safe first slice, when approved: create a read-only/admin-gated content approval prototype or data contract for Rex-owned social prep. No Buffer/Meta/TikTok/Pinterest action.
- Add server-contract tests before any mutable version exists: creative approval cannot set posting approval, queue prep cannot schedule/post, discount copy is blocked, and real-proof risk requires explicit clearance.

## Current Surface Mapping

Already complete:

- `/samples`: deploy-candidate commit `97f4450` adds `Kind Dragon` and `Year of Lights` samples, sanitized assets, hardcover photo support, and forbidden-copy regression coverage.

Do next only after explicit scoped approval:

- Preview-only CD-3 component/data slice for private growth-loop CTAs.
- Internal/admin content approval board prototype or data contract.

Do not do from these exports:

- Production deploy or alias.
- Public launch / social push / promo copy.
- Public ERIC50 or discount use.
- Gift-copy live order flow.
- Proof release, proof email, order-state advancement, or print/provider action.

## Proposed Acceptance Criteria For HER-92

- Source artifact paths and normalized-diff finding are recorded.
- Safe-now, future-gated, and blocked concepts are classified.
- Target surfaces are identified without expanding public scope.
- Any later code patch keeps gates closed by default.
- Tests block forbidden phrases and dangerous effects:
  - same-day delivery
  - guaranteed arrival
  - public ERIC50 / discount copy
  - auto proof release
  - auto print / ready-to-print / final-proof claims
  - public share/gallery/feed promises
- Verification for any code slice includes focused tests, build, and mobile/desktop browser smoke.

