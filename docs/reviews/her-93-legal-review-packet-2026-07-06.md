# HER-93 Legal Review Packet — Fully Custom Checkout Phase A

Date: 2026-07-06
Owner: Rex
Scope: Hero Story Books checkout copy/data contract changes for a more custom family story intake.

## Current Phase-A behavior

- Primary hero UI remains child-only for paid checkout.
- Adult/parent/grandparent primary hero options remain hidden until story generation support ships in the same release.
- Additive order fields collect family-story context:
  - `heroName`, derived from current child/main-hero name
  - `heroType`, fixed to `child` in Phase A UI
  - `recipientName`, `recipientRelationship`
  - `heroPhotoFocusLabel`, `heroPhotoCropHint`
  - supporting character `focusPersonLabel`, `cropHint`
- Existing legacy `childName` remains populated for compatibility.
- Optional story inspiration upload remains behind feature gates and requires explicit consent when a file is attached.
- Upload copy states the material is inspiration only, not voice cloning, not published audio, and gives a manual deletion request path.

## Legal/privacy surfaces touched

- Checkout may collect child/family photos.
- Checkout may collect optional audio, text, PDF, or Word notes when feature-gated upload is enabled.
- Copy and policy pages now mention family/adult reference media, relationship context, consent, no model training promise, and manual deletion path.
- No face-capture camera feature is added in Phase A.
- No adult primary hero sales path is enabled in Phase A.

## Review questions for counsel / owner approval

1. Is the revised checkout consent language sufficient for family/child photo and optional story-note upload in Illinois?
2. Does the current no-training / order-only-use copy need narrower provider-specific qualifiers?
3. Is the manual deletion-request language acceptable without promising automated deletion by a fixed date?
4. Do privacy/terms need a specific retention/destruction schedule before enabling `NEXT_PUBLIC_HSB_STORY_UPLOAD` in production?
5. Should audio uploads be disabled in production until transcript extraction and retention policy are separately approved?
6. Does collecting photo focus/crop/person labels create any biometric/likeness-risk language requirements even without face embeddings or identity verification?
7. Are adult-family-member co-hero descriptions safe while primary adult hero checkout remains hidden?

## Production gates before enabling story upload broadly

- Counsel/owner approval of Privacy + Terms + checkout consent copy.
- Confirmation that runtime storage, provider use, and deletion workflow match public copy.
- Preview Stripe test-mode checkout with upload consent path verified.
- Admin order detail verified to expose uploaded-story context so customers are not misled that uploads are unused.
- No live production feature-flag enablement without explicit Alexy approval.

## Phase-A legal verdict

- Safe to preview/test in isolated Vercel Preview with Stripe test mode and non-production storage.
- Hold production enablement of `NEXT_PUBLIC_HSB_STORY_UPLOAD` pending explicit legal/owner approval.
- Hold adult/parent/grandparent primary hero sales path pending generator support and legal/copy review.
