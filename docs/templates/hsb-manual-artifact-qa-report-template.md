# HSB Manual Artifact QA Report

Order: `<orderId>`
Reviewer: `<name>`
Reviewed at: `<timestamp>`
Artifact manifest: `<path-or-blob-ref>`
Revision: `<revision>`

## Artifact completeness

- [ ] Story brief present
- [ ] Page plan present
- [ ] Prose present
- [ ] Art-direction packet present
- [ ] Page images present: `<count>/<expected>`
- [ ] Proof PDF present
- [ ] QA report present

## Story/prose QA

- [ ] Child/family details are correct
- [ ] Story feels custom, not generic/template
- [ ] No fallback/template source is used
- [ ] No child/family reuse from another order
- [ ] Tone is age-appropriate
- [ ] No obvious grammar/repetition issues

## Art QA

- [ ] Every page image loads
- [ ] Art is visually consistent across pages
- [ ] Child likeness/reference handling is acceptable and safe
- [ ] No fixture/sample/internal asset appears
- [ ] No visible watermark/provider artifact/prompt text
- [ ] No missing or duplicate pages

## Proof PDF QA

- [ ] Proof PDF opens on desktop
- [ ] Proof PDF opens on mobile or mobile-sized viewport
- [ ] Page order is correct
- [ ] No broken images
- [ ] Text is readable and not clipped
- [ ] Review/proof link can be generated after release

## Safety gates

- [ ] Customer proof/email has not been sent before QA pass
- [ ] Print has not been submitted
- [ ] Customer approval is still required before print
- [ ] Owner print-go is still required before print
- [ ] Manifest/release guard has no blockers

## Decision

- [ ] PASS — ready for explicit customer proof release
- [ ] FAIL — keep/revert to manual generation; see blockers below

## Blockers / fixes required

- `TODO`

## Side-effect attestation

No prod deploy/env change/payment/refund/customer email/proof release/print submission was performed by this QA review.
