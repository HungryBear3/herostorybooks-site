# Fully Custom Checkout Phase A QA

Date: 2026-07-07
Branch: `rex/her93-fully-custom-checkout-phase-a-clean`
PR: #87
Preview: `https://herostorybooks-site-l2mfltpdp-alexy-kapluns-projects.vercel.app`

## Scope

Phase A keeps paid checkout child-hero only while adding backward-compatible custom-story intake fields, co-hero/family context, photo focus hints, and optional story inspiration upload behind preview/test gates. No adult/parent/grandparent primary-hero sales path is enabled in this phase.

## Environment verification

| Check | Result |
|---|---|
| Preview deployment | Ready / Vercel success |
| Stripe mode | Test secret (`sk_test...`), `livemode=false` |
| Blob namespace | `preview` |
| Admin key | Present in branch preview env |
| Story upload flag | Preview voice/story upload visible |
| Production mutation | None |

## Manual preview QA

| Scenario | Result | Evidence / notes |
|---|---|---|
| Checkout loads | PASS | `/checkout` returns 200 on preview. |
| Child-hero-only paid path | PASS | UI says every paid book currently stars a child; adult-led hero stories are on preview hold. |
| Adult/parent/grandparent primary hero hidden | PASS | No primary-hero type picker is exposed; parent/grandparent are only add-on co-hero/family buttons. |
| Flexible family context | PASS | Section is labeled “People, pets, and family details”; includes co-hero, Dad, Mom, Sibling, Grandparent, Dog/pet. |
| Photo-later path | PASS | Copy allows starting now and adding a photo later before order/payment. |
| Still-photo consent/camera guard | PASS | Camera buttons are disabled until parent/guardian permission checkbox is selected. |
| Optional story inspiration upload | PASS | Section is visible in preview: “Add a story voice note or family memory”; Record audio and Upload audio file buttons render. |
| No voice cloning copy | PASS | Upload section states recordings are inspiration only and not used for voice cloning. |
| Privacy page | PASS WITH LEGAL HOLD | Privacy route 200; contains consent, retention/deletion, family/adult media language. Legal review still required before broad production enablement. |
| Terms page | HOLD | Terms route 200 and carries source-level legal marker, but public terms copy is lighter than privacy page. Keep legal/owner approval gate before production story-upload enablement. |

## Stripe test-mode E2E

Created a preview/test Checkout Session via `POST /api/order` using branch Preview env. No live charge.

| Field | Result |
|---|---|
| HTTP response | 200 |
| Checkout Session | `cs_test_...` |
| Stripe livemode | `false` |
| Payment status | `unpaid` |
| Amount | 1900 USD |
| Client reference / metadata order | `ord_6a053f3f7a684a2d` |
| Preview admin order read | 200 |
| `childName` | `QA Hero` |
| `heroName` | `QA Hero` |
| `heroType` | `child` |
| `heroAgeOrStage` | `7 years old` |
| `recipientName` | `QA Recipient` |
| `recipientRelationship` | `hero to recipient` |
| `storyPerspective` | `child-hero` |
| `heroPhotoFocusLabel` | `QA Hero` |
| `heroPhotoCropHint` | `center` |

Note: Hosted Stripe Checkout rendered “Something went wrong” in the Browserbase automation surface, while direct HTTP and Stripe API retrieval show the test Checkout Session is valid/open. Treat hosted-browser payment completion as environment-blocked, not a route/API failure.

## Local verification

```bash
node --experimental-strip-types --test \
  tests/checkout-flow.test.ts \
  tests/checkout-name-param.test.ts \
  tests/checkout-color-tokens.test.ts \
  tests/checkout-voice-default.test.ts
# PASS 25/25

node --experimental-strip-types --test \
  tests/voice-upload.test.ts \
  tests/checkout-voice-default.test.ts
# PASS 21/21

node --experimental-strip-types --test \
  tests/story-generator-format-aware.test.ts
# PASS 11/11

npm run build
# PASS
```

Caveat: `npm test -- checkout` is not a focused filter in this repo; it expands into the full suite and can hit unrelated baseline blob/env failures. Use explicit test file paths above.

## Remaining gates before merge / production enablement

- Keep PR #87 as draft until owner/legal approves privacy/terms/consent scope.
- Do not enable adult/parent/grandparent primary-hero sales path until generator support and tests ship with it.
- Do not enable story upload broadly in production until legal/owner approval confirms retention/deletion and provider-use copy.
- If full hosted Stripe payment completion is required, run it from a normal browser or Stripe dashboard test flow; Browserbase showed an automation-only Checkout rendering error.

## Verdict

Phase A preview and API-level Stripe test-mode E2E pass for the child-hero/custom-intake slice. Production launch is still held by legal/owner approval, not by build/test/Vercel readiness.
