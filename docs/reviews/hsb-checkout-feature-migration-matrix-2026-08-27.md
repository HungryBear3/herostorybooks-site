# HSB checkout — complete feature / state migration matrix

- **Date:** 2026-08-27 · **Base:** `origin/main` @ `edf23f8` · **Branch:** `cc/hsb-checkout-ux-audit-20260827`
- **Parent:** [`hsb-checkout-ux-audit-2026-08-27.md`](./hsb-checkout-ux-audit-2026-08-27.md)
- **Purpose:** every field, validation, state transition, feature, trust statement, promo-code behavior, Stripe handoff, attribution/consent behavior, photo rule, accessibility behavior, and mobile behavior that exists today → where it lands in the five-step target → the test that proves it was preserved.

Target step ids used below: **S1** Who is the hero · **S2** The story · **S3** Photos · **S4** Format · **S5** Pay · **ST** post-payment status page · **DROP** intentionally removed.

Legend for *Preservation test*: `U` = unit test (`tests/*.test.ts`), `E` = Playwright e2e (`tests/e2e/*.spec.ts`), `C` = copy/contract assertion. Tests marked **(new)** do not exist yet.

---

## 1. Form fields

| # | Field | Current location | Required? | Constraint | → Target | Preservation test |
|---|---|---|---|---|---|---|
| 1 | `heroType` | `checkout-form.tsx:1391-1417` (only when `NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA`) | defaults `child` | server allowlist `{child,parent,grandparent}`, `route.ts:74`; non-child refused unless `HSB_PRIMARY_HERO_BETA`, `route.ts:303-309` | **S1** — render always; parent/grandparent visibly **"Coming soon"** + `aria-disabled`, not selectable while flag off | U **(new)**: flag off ⇒ only `child` selectable and helper text never says "by review only" |
| 2 | `childName` (posted also as `heroName`) | `:1421-1441` | ✅ | non-empty (`checkout-flow.ts:70`); URL prefill sanitized to 24 chars, punctuation/control stripped (`:325-341`) | **S1** | U: `tests/checkout-name-param.test.ts`; U: `order-route-required-fields.test.ts` |
| 3 | `childAge` → `heroAgeOrStage` | `:1441-1474` | ❌ | `child` ⇒ `<select>` 2–12; else free text ≤40 | **S1** | U **(new)**: select↔text swap follows `heroType` |
| 4 | `recipientName` | `:1480-1497` | ❌ (✅ if `heroType != child`) | ≤80; `route.ts:310-318` requires it with `recipientRelationship` for non-child | **S1** | U: server 400 `primary_hero_recipient_context_required` |
| 5 | `recipientRelationship` | `:1498-1516` | ❌ (✅ as above) | ≤80 | **S1** | same as #4 |
| 6 | `theme` (story direction) | `:1183-1250` custom card + 6 templates | ✅ | must be in `LAUNCH_THEME_IDS` (`:42-50`); `?direction=` maps via `DIRECTION_TO_THEME` (`:65-81`) | **S2** | U: `checkout-flow.test.ts` (`selectAdventureValue` — reselect must not deselect) |
| 7 | `customStoryMemory` | `:1329-1355` | ❌ | ≤1200 chars; only when `theme === custom-voice-story` | **S2** | U: `checkout-voice-default.test.ts` |
| 8 | `customStorySourceMode` | `:1277-1300` | ❌ | `audio` \| `written` \| `''` | **S2** | U: "one audio card and one typing card, not two audio cards" (existing) |
| 9 | `voiceFile` / `voiceSource` | `VoiceRecorderSection.tsx` via `:1306` | ❌ | gated on `NEXT_PUBLIC_HSB_STORY_UPLOAD` (`:178`); server: audio/txt/pdf/doc only (`route.ts:89-102`), ≤15 MB `MAX_VOICE_BYTES` | **S2** | U: `voice-upload.test.ts`; U: "attaches voice fields to FormData only when story upload is on" |
| 10 | `voiceConsent` | `VoiceRecorderSection` | ✅ **iff** voiceFile | server 400 `voice_consent_required` (`route.ts:205-213`) | **S2** | U: "blocks submit when voice attached without consent" |
| 11 | `lesson` (+ custom) | `:1519-1560` | ❌ | preset id or free text ≤80 | **S2** | U **(new)**: preset and custom are mutually exclusive |
| 12 | `occasion` (+ custom) | `:1565-1608` | ❌ | preset id or free text ≤80/≤100 from URL | **S2** | U **(new)**: clearing occasion also clears `giftMessage` (`:1571-1577`) |
| 13 | `giftMessage` | `:1618-1647` | ❌ | ≤200; **only revealed when `occasion` set** | **S2** | U **(new)**: reveal/clear coupling |
| 14 | `photoFile` / `photoDataUrl` (hero) | `:2213-2272` | ❌ | client shrink ≤1.1 MB (`:38`); server ≤12 MB + sharp re-decode (`photo-file-validation.ts`) | **S3** | U: `photo-file-validation.test.ts`, `photo-upload.test.ts` |
| 15 | `heroPhotoFocusLabel` | `:2184-2192` | ❌ | ≤120; only when a photo exists | **S3** | U **(new)**: not posted without a photo |
| 16 | `heroPhotoCropHint` | `:2193-2208` | ❌ | enum of 9 positions | **S3** | U **(new)**: enum round-trip |
| 17 | `characterNotes` (hero appearance) | `:1685-1704` (no photo) / `:1671-1683` (with photo) | ✅ **iff** no photo | ≤240; server `appearance_description_required` (`checkout-flow.ts:72`) | **S3** | U: `order-route-required-fields.test.ts` |
| 18 | `mustInclude` + `mustIncludeOther` (hero) | `:1707-1745` | ❌ | 6 presets; `custom-detail` reveals ≤80 text | **S3** | U **(new)**: `custom-detail` reveal |
| 19 | `familyCharacters[]` (≤4) | `:1751-2086` | ❌ | human ⇒ name + (photo **or** notes) (`checkout-progressive.ts:139-157`); pet ⇒ name only | **S3** | U: `checkout-progressive.test.ts`; U: `supporting-character-photo-gate.test.ts`; U: `checkout-photo-policy.test.ts` |
| 20 | supporting `photoFile`/`focusPersonLabel`/`cropHint` | `:1897-2000` | ❌ | same photo contract as #14 | **S3** | U: `checkout-photo-policy.test.ts` |
| 21 | `guidedFrames` + `guidedConsent` | `GuidedPhotoCapture.tsx` via `:2303` | ❌ | flag `isGuidedPhotoCaptureEnabled()`; appended only with consent (`:949-951`) | **S3** | U: `guided-photo-capture.test.ts` |
| 22 | `bookFormat` | `:2333-2386` | ✅ | `{digital,classic,premium}`; **`normalizeFormat` silently falls back to `classic`** — see audit F-05 | **S4** | U **(new)**: unknown format ⇒ 400, not $39 |
| 23 | `email` | `:2402-2412` | ✅ | regex `checkout-flow.ts:65`; **`isReadyToPay` checks presence only** — audit F-07 | **S5** | U **(new)** T-4: `"abc"` ⇒ CTA disabled |
| 24 | `referralCode` | `checkoutReferralCode()` `:378-388` | ❌ | `?ref=` or `hsb_ref` cookie, `^[a-z0-9][a-z0-9_-]{1,63}$`; **posted as `referralCode`, never `ref`** (see audit §8.1 S-1) | **S5** (hidden) | U **(new)**: field name is not `ref`/`utm_*` |
| 25 | `cohort` / `invite` | `checkoutTrackingFromSearchParams` `:936-938` | ❌ | `buildCheckoutTracking` (`route.ts:147-150`) | **S5** (hidden) | U: `checkout-tracking.test.ts` |
| 26 | `gaClientId` | `currentGaClientId()` `:939-940` | ❌ | `_ga` cookie, `GA\d+\.\d+\.(\d+\.\d+)` (`analytics.ts:201-211`), server-sanitized | **S5** (hidden) | U: `tests/google-analytics-tag.test.ts` |
| 27 | `checkoutAttemptId` | `:848-854` (sessionStorage) | ✅ | `^[a-f0-9]{32}$` (`route.ts:141`); **derives the durable order id** `ord_${sha256(id).slice(0,16)}` (`route.ts:388`) | **S5** (hidden) — reuse on resume, audit §6.2(5) | U **(new)** T-10: same attempt id ⇒ same `ord_` id |
| 28 | `customStoryBrief` | not sent by this form | ❌ | `route.ts:323-359` — concierge/paid-beta gates | **DROP** from UI; keep the server gate untouched | U: existing custom-story tests |
| 29 | `childPronouns` | **not collected** (`route.ts:152`) | ❌ | removed by PR #107 by decision | **DROP** — do not reintroduce | U: `tests/checkout-flow.test.ts` comment contract |

---

## 2. Step / state machine transitions

| Current | Where | Behavior | → Target |
|---|---|---|---|
| 5 step ids `hero-details / hero-appearance / story / people / review` | `checkout-progressive.ts:39` | drives visibility (`hidden` class) + chip row | Replaced by `hero / story / photos / format / pay` |
| `review` hard-coded `complete:false` | `:276` | makes it permanently the "current" step once earlier steps pass | Keep the intent (pay is never "done" pre-payment) but express it explicitly |
| `needs_attention` outranks `current` | `:310` | any open supporting draft pulls focus to `people` | Keep; **add** an `aria-live` announcement (audit F-17) |
| Forced-back effect | `checkout-form.tsx:707-714` | resets `currentStepId` when an earlier step becomes blocking | Keep; announce |
| Forward-gating | `canNavigateToCheckoutStep` `:330-338` | target index ≤ first incomplete index | Keep; chips get `aria-disabled` + reason instead of bare `disabled` |
| `continueCurrentStep` | `:739-748` | validates then advances; **no-op on last step** (audit F-11) | Replace with a single sticky CTA that becomes submit on S5 |
| Step id in history | **none** | system Back leaves checkout | **Add** `history.pushState` per step (audit §6.2) |
| `success` interstitial | `:1004-1031` | 1200 ms delay then `location.href` | Keep; fix "We saved your details" wording (audit §3 G-2) |

---

## 3. Trust statements and copy constants

| Constant / string | Source | Currently rendered at | → Target | Preservation test |
|---|---|---|---|---|
| `PROOF_TURNAROUND_WINDOW` = "2–3 business days" | `proof-turnaround.ts:13` | checkout `:101`,`:113`,`:123`,`:2596`; thank-you; status; catalog | **S4 + S5 + ST** — single source, never re-typed | C: `checkout-capacity-and-processing-expectations.test.ts` |
| `PROOF_REVIEW_ASSURANCE` | `proof-turnaround.ts:43` | `:2596-2598` | **S5** | C: existing — must not claim human QA (Rex 2026-08-21) |
| `PROOF_VOLUME_NOTE` | `:52` | `:2598`; status `order-status-view.ts:120` | **S5 + ST** | C: `order-status-processing-note-states.test.ts` |
| `PROOF_DELAY_SUPPORT_NOTE` | `:56` | status + thank-you | **ST** | C: existing |
| `PRINT_PREVIEW_PROMISE` | `checkout-flow.ts:10` | `:2414` | **S5** | C **(new)** |
| `PROMO_CODE_HELP` = "Enter promo codes on the next secure Stripe page before payment." | `checkout-flow.ts:24` | `:2330` (currently inside the **format** section) | **S5** — must sit next to the pay CTA, not the format cards | C: `checkout-promo-code-copy.test.ts` |
| "Nothing prints until **you** say so" 3-step panel | `:2571-2612` | aside, all steps | **S5** | C **(new)** |
| "Secured by Stripe · Proof approval before printing · Your data is never shared" | `:2691-2694` | under CTA | **S5** | C **(new)** |
| Photo privacy line ("never to train AI") | `:2276` | photo section | **S3** | C **(new)** |
| Voice privacy line | `:1356` | story section | **S2** | C **(new)** |
| Supporting-photo honesty ("proof-team references only, not guaranteed direct likeness conditioning") | `:1904` | people section | **S3** — keep verbatim | C **(new)** |
| Father's Day countdown banner | `:2323-2328` via `getFathersDayCountdown()` | format section | **S4** | U: `fathers-day` tests |
| Checkout-paused page | `page.tsx:8-52`, `checkout-pause.ts` | whole route | unchanged | U: `checkout-pause.test.ts` |
| **Risk-reversal / refund copy** | **does not exist on checkout today** | — | **S5** — new, blocked on **D-01** | C **(new)** T-1 |
| FAQ "replacement or full refund" within 30 days | `faq-section.tsx:30` | `/` FAQ | **conflicts with** `terms/page.tsx:25` — blocked on **D-03** | C **(new)** T-1 |

---

## 4. Photo rules

| Rule | Where enforced | Layer | → Target |
|---|---|---|---|
| Hero photo optional; description required without it | `checkout-flow.ts:72`, client `:689-696` | both | **S3**, unified predicate (PR-3) |
| `likenessIntent` derived from *actual* photo presence, never a buyer toggle | `checkout-flow.ts:54-56`, `route.ts:195-199` | server-authoritative | **S3** — do not surface as a control |
| Accept list `image/jpeg,png,webp` | `:156` (`accept` hint only) | client hint | **S3** — enforce in the change handler (PR-7) |
| Drag-drop accepts any `image/*` | `:816` | client | **S3** — tighten (audit F-14) |
| Client shrink to ≤1.1 MB, else hard error | `:38`, `:750-773` | client | **S3** — raise toward 12 MB (PR-7) |
| Server ≤12 MB, ≤40 MP, ≤12000 px, sharp re-decode, declared-type must match decoded format | `photo-file-validation.ts:3-6,46-80` | server | unchanged |
| Supporting photo metadata from the client is always discarded | `clearUntrustedSupportingPhotoMetadata` (`checkout-photo-policy.ts:3-13`) | server | unchanged |
| Human supporting character needs a **real uploaded file** or notes | `missingSupportingCharacterDescriptionLabels(chars, actualPhotoIndexes)` (`checkout-photo-policy.ts:23-33`) | server | unchanged — **this is what audit F-03 trips** |
| Photo upload failure aborts **before** Stripe | `route.ts:459-479` | server | unchanged — payment-seam, do not touch |
| Guided frames appended only with parent consent | `:949-951` | client | **S3** |

---

## 5. Stripe handoff

| Element | Where | → Target |
|---|---|---|
| Single session-creation site | `route.ts:652` | unchanged (seam) |
| `allow_promotion_codes: true` | `route.ts:654` | unchanged — this is *why* `PROMO_CODE_HELP` exists |
| `client_reference_id` / `metadata.orderId` | `:656-663` | unchanged |
| `payment_intent_data.metadata.orderId` | `:666` | unchanged — lets refund/dispute events converge |
| `price_data` bound to a stable Product id | `:668-676`, `getRequiredStripeProductId` (`:397`) | unchanged — fails closed |
| `shipping_address_collection` US-only for print | `:677-679` | unchanged |
| `success_url` carries `orderId,childName,format,email,sessionId` | `:640-650`, `:684` | **S5 → reduce to `orderId` + `sessionId`** (audit F-16) |
| `cancel_url` = `/checkout` (bare) | `:681` | **S5 → `?resume=1`** (PR-6, HELD) |
| `idempotencyKey: hsb_checkout_${order.id}` | `:686` | unchanged |
| `bindOrderCheckoutSession` must succeed or no URL is released | `:688-696` | unchanged |
| Open-session replay returns the existing URL | `:406-413` | unchanged — **enables PR-6 resume** |
| `checkoutLease` renewed before every media write and before session create | `:436-444`, `:651` | unchanged |

---

## 6. Attribution / consent behavior

| Behavior | Today (`edf23f8`) | After PR #158 (`9ae155f`) | → Target |
|---|---|---|---|
| Consent surface | **none** — GA4 + Vercel Analytics fire unconditionally (`analytics.ts:26-38`) | consent-gated (`consent-surface.tsx`) | inherit #158; wizard adds no new tracker |
| `page_location` sent to GA | query string **stripped** (`analytics.ts:185-188`) | unchanged | **preserve** — this is what keeps `?childName=` out of GA |
| Stripe referrer suppressed | `isUnwantedReferral` (`:190-199`) | unchanged | preserve |
| Campaign params | `utm_*` + `ref` from URL, sessionStorage-cached (`:139-151`) | governed 4-field tuple, whole-tuple rejection | inherit |
| Checkout events | `begin_checkout` (`:461`), `story_selected` (`:1188`), `format_selected` (`:2340`), `order_submit_attempt` + `purchase_intent` (`:838-839`) | plus governed attribution on the POST | **add per-step view event** (audit U-05) |
| Child name in events | never a value — only `"yes"/"no"` (`:466-467`) | unchanged | **preserve this discipline** |
| Server re-validates attribution | n/a | `validateUtmTuple` + `ungovernedCampaignKey([...form.keys()])` | **any new form field named `ref` or `utm_*` breaks it** — audit §8.1 S-1 |

---

## 7. Accessibility behaviors

| Behavior | Today | → Target | Test |
|---|---|---|---|
| `aria-pressed` on multi-select chips | ✅ `:1717`, `:1866` | keep as the reference pattern | E **(new)** T-5 |
| `aria-current="step"` on active chip | ✅ `:1082` | keep, inside `<nav><ol>` | E T-5 |
| `role="alert"` on step error | ✅ `:1102` | keep | E T-5 |
| `aria-live="assertive"` on submit error | ✅ `:2658` | keep | E T-5 |
| `aria-expanded` on guided-photo toggle | ✅ `:2283` | keep | E T-5 |
| Single-select radio semantics | ❌ (audit F-10) | `role="radiogroup"`/`radio` + `aria-checked` + arrow keys | E T-5 |
| `aria-invalid` / `aria-describedby` | ❌ (audit F-08) | add + visible message | E T-5 |
| Keyboard-reachable photo drop zone | ❌ (audit F-09) | `<button>`/`<label>` | E **(new)** T-6 |
| Single `<h1>` | ❌ two (`:1059`, `:2431`) | one | E T-5 |
| 44px touch targets | ❌ chips `px-3 py-1.5` (`:1083`) | ≥44px | E T-5 |
| Step-change announcement | ❌ | `aria-live="polite"` | E T-5 |
| `prefers-reduced-motion` | ❌ | honour | E T-5 |
| Hidden steps are `display:none` (not focusable) | ✅ | keep — **and never mark a hidden field `required`** (latent native-validation trap) | U **(new)** |

---

## 8. Mobile behaviors

| Behavior | Today | → Target | Test |
|---|---|---|---|
| Order summary | below all content, non-sticky (`:1159`, `:2426`) — audit F-06 | sticky collapsed accordion `< lg` | E **(new)** T-9 on `mobile-chromium` |
| Pay CTA | inside the aside, bottom of page, present on every step | sticky bottom bar, one per step | E T-9 |
| Two CTAs (header Continue + pay) | ✅ present — audit F-11 | one | E T-9 |
| Price on mobile format cards | duplicated into a `sm:hidden` total row (`:2376-2385`) | fold into the persistent summary | E T-9 |
| Brand badge hidden `< sm` to protect the wordmark | `:1043-1044` (deliberate) | keep | — |
| Camera capture (`capture="user"`) | ✅ `:2261-2263` | keep | E T-6 |
| Auto-shrink notice for large phone photos | ✅ `:38`, `buildAutoShrinkNotice` | keep; widen ceiling (PR-7) | U: `photo-upload.test.ts` |
| System Back button | leaves checkout entirely | walks steps | E **(new)** T-8 |
| HEIC from iOS picker | unknown — audit U-06 | live device evidence needed | — |

---

## 9. Post-payment status (goal 3) — preserve as-is

| Operational state | Source | Status-page rendering | Must survive |
|---|---|---|---|
| `received` | always `'done'` | `order-status-view.ts:230`, `:271` | ✅ |
| payment `paid`/`failed`/pending | `paymentStatus` | `:231-235`, `:272-276` | ✅ never inferred from URL (`thank-you/page.tsx:10-14`) |
| `not_started` → `generating_story` → `generating_images` → `building_pdf` | `fulfillment.ts:211`,`:521`,`:597` | "Creating your book" | ✅ |
| queue-honesty note gated to exactly those 4 states | `AWAITING_PROOF_PRODUCTION` `:53-58` | `:119-121` | ✅ **do not widen** |
| `proof_ready` (print) | `fulfillment.ts:816` | "action" tone, "View Proof", `needsAction` | ✅ |
| `complete` (digital) | `fulfillment.ts:626` | "success", download CTA | ✅ |
| `proof_approved` → `submitting_to_print` | `:1459` | "Sending to print" | ✅ |
| `print_in_production` / `shipped` + tracking | `status`, `trackingNumber/Url/shippedAt` | `:170-182`, page `:36-60` | ✅ |
| `delivery_email_failed` | `:676`,`:870` | excluded from the volume note **on purpose** | ✅ |
| `failed_manual_review` | `:458`,`:474` | failure tone, no CTA, personal-contact copy | ✅ |
| `fulfillmentMode: 'manual_hold'` on every order | `route.ts:390-393` | not rendered | ✅ **never infer from product/payment/cohort** |
| Refund refusal ladder | `admin-actions.ts:545-568` | admin only | ✅ — and see audit F-01 before writing any customer refund copy |
| Replay-on-refunded refusal | `webhooks/stripe/route.ts:331-335` | — | ✅ |

---

## 10. Explicitly dropped

| Item | Where | Why |
|---|---|---|
| `import { Progress }` | `checkout-form.tsx:5` | never rendered (audit F-12) |
| `CHECKOUT_STEPS` | `:189-195` | stale 5-label list; only feeds a dead divisor |
| `completedStepCount` / `progressValue` | `:698-705` | never rendered |
| `CHECKOUT_SECTION_ORDER` | `checkout-flow.ts:1-8` | describes the pre-#137 section order; no consumer |
| `currentCheckoutStep` / `CurrentCheckoutStep` | `checkout-flow.ts:58-114` | superseded by `checkout-progressive.ts`; disagrees with it |
| `src/lib/pricing.ts` + `src/components/pricing-section.tsx` | — | imported by no live route; marks the **wrong** tier featured (audit F-15) |
| `src/components/landing/*` | — | imported by no live route; links to the dead `/order` |
| `/order` route | `src/app/order/page.tsx` | live dead-end (audit F-13) — needs ruling U-09 |
| `POST /api/checkout` 404 stub | `src/app/api/checkout/route.ts` | retired; delete or document |
| `childPronouns` | — | removed by decision (PR #107); **do not reintroduce** |

---

## 11. Test-gate summary

| Gate | Kind | Proves | Slice |
|---|---|---|---|
| T-1 | C **(new)** | no unsupported refund claim on any surface; FAQ/Terms/catalog agree | PR-1 |
| T-2 | U **(new)** | no `File`/base64 reaches `localStorage`; restored photo says "Re-attach" | PR-2 |
| T-3 | U **(new)** | `isReadyToPay` ⇔ zero blockers ⇔ server `missingRequiredField` | PR-3 |
| T-4 | U **(new)** | malformed email disables the CTA | PR-3 |
| T-5 | E **(new)** | axe-core clean per step, desktop + mobile | PR-4 |
| T-6 | E **(new)** | keyboard reaches both photo controls | PR-4 |
| T-7 | U **(new)** | new 5-id step machine incl. forward gating | PR-5 |
| T-8 | E **(new)** | system Back walks steps, does not exit checkout | PR-5 |
| T-9 | E **(new)** | exactly one enabled primary CTA; summary persistent on mobile | PR-5 |
| T-10 | U **(new)** | same `checkoutAttemptId` ⇒ same `ord_` id on resume | PR-6 (HELD) |
| T-11 | U **(new)** | storage cleared only on confirmed `paid` | PR-6 (HELD) |
| T-12 | U **(new)** | GIF/HEIC rejected at select, not at pay | PR-7 |
| T-13 | U **(new)** | 6 MB JPEG accepted client-side | PR-7 |
| T-14 | C **(new)** | every badge maps to a product attribute; labels match `FORMAT_META` | PR-8 |
| — | U (existing, must stay green) | `checkout-progressive`, `checkout-flow`, `checkout-photo-policy`, `checkout-promo-code-copy`, `checkout-capacity-and-processing-expectations`, `order-route-required-fields`, `order-status-view`, `order-status-processing-note-states`, `supporting-character-photo-gate`, `guided-photo-capture`, `photo-file-validation`, `photo-upload`, `checkout-tracking`, `checkout-name-param`, `checkout-pause`, `checkout-voice-default` | all |

Baseline on this branch: **`npm test` → 1765/1765 pass, 0 fail.**
