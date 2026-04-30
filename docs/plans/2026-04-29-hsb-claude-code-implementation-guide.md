# HSB Claude Code Implementation Guide

> Source of truth plan: docs/plans/2026-04-29-hsb-final-consolidated-launch-plan.md
> This document is the implementation contract. The plan is the source of truth for what and why; this guide is the source of truth for how to build it and in what order.

## 0. Read this first

This is not a greenfield build. HSB has a live site at www.herostorybooks.com. Most work is modifying existing flows, adding gates that don't currently exist, and removing or rewiring patterns that conflict with the launch plan. Before changing any file, read the plan section that governs that area, then read the existing implementation, then make the smallest change that conforms to the plan.

Decisions are locked. Where the plan says X, build X. Do not improvise. Do not improve. If a decision appears to be missing, stop and ask — do not pick.

Hard constraints:
- No silent text-only fallback on paid hero pages, ever.
- No print without QA sign-off recorded in the order record.
- No print without explicit customer approval recorded with timestamp.
- No partial refunds.
- No order shipped without all logging fields populated.

If a code path could violate any of these under any circumstance, that path is wrong.

## 1. Build order

Build in this sequence. Each phase is gated on the previous phase being complete and tested. Do not parallelize phases.

### Phase 1: Data model and logging foundation

Before changing any user-facing flow, get the data right. Every other phase depends on this.
- Order record schema additions (per Plan §10):
  - canonical_child_spec (JSON: age_band, skin_tone, hair_color, hair_texture, gender, glasses, notable_features, headwear)
  - qa_status (enum: pending, approved, rejected_for_regen, escalated, refunded)
  - qa_reviewer (string, owner who signed off)
  - qa_timestamp
  - customer_approval_timestamp
  - regen_count_auto (int)
  - regen_count_customer (int)
  - escalation_status (enum: none, queued, in_progress, resolved, refunded)
  - escalation_queued_at (timestamp, for 12-hour SLA tracking)
  - photo_retention_until (timestamp, ship date + 30 days)
  - photo_retention_opt_in (bool)
- Per-page record schema (one row per generated page, linked to order):
  - page_type (enum: cover, hero_interior, non_hero)
  - page_index (int)
  - provider (enum: seedream, nano_banana, template_static, text_only_fallback)
  - model (string, exact model identifier)
  - seed (string or null)
  - prompt_hash (string)
  - conditioning_mode (enum: photo_conditioned, structured_only, template)
  - output_url (string)
  - regen_count (int)
  - manual_review_flag (bool)
  - created_at (timestamp)
- Acceptance: every existing order in the system has these fields populated (backfill nulls where unknowable, but the schema exists and new orders populate it).

### Phase 2: Photo intake gate

Per Plan §4 and Block F decisions.

- Build photo upload flow with these gates (server-side is source of truth, client-side is for UX speed):
  - Min resolution 1024×1024, reject below.
  - Max file size 10 MB.
  - Accept JPEG, PNG, HEIC. HEIC is critical — iPhone default. Do not skip HEIC support.
  - Reject if no face detected.
  - Reject if multiple faces detected. Error copy: "Please upload a photo with just your child. We'll add multi-child books in the future."
  - Reject if face is less than 15% of image area. Error copy: "Please use a closer photo where your child's face is clearly visible."
  - Reject if face is heavily occluded (sunglasses covering eyes, mask, hand over face).
  - Reject if image is grayscale. Error copy: "We need a color photo to capture your child's hair and skin tone."
- Show parent the cropped face that will be used as conditioning input, with "looks good" / "try a different photo" buttons.
- On-screen examples: 3 "good photo" thumbnails, 3 "won't work" thumbnails (blurry, side angle, sunglasses, group shot). Static images, no need for animation.
- All rejection reasons must be human-readable and specific. No generic "upload failed."

### Phase 3: Structured input flow and canonical child spec

Per Plan §2 Input scope and Plan §4 canonical child spec.

- After photo passes intake gate, parent is prompted for structured fields. All required, block on missing.
  - Child name (text, required, shown back for visual confirmation later)
  - Age band (dropdown, required)
  - Gender (radio: male / female, required)
  - Skin tone (dropdown with picker images, required)
  - Hair color (dropdown, required)
  - Hair texture/style (dropdown with picker images, required)
- Optional fields: glasses (yes/no), notable features (short text), headwear (dropdown).
- After structured input, build the canonical child spec as a frozen JSON object stored on the order. This object is reused across all hero page generations — do not let any hero page generate without it, and do not let any hero page generate with a different child spec than the order's frozen copy.
- Show the parent a confirmation screen: "This is what we'll draw" with the structured spec rendered in plain language ("A 5-year-old boy with light brown skin, curly black hair, glasses"). Parent confirms or edits before generation runs.
- Theme selection happens after canonical spec confirmation.
- Format selection (digital / softcover / hardcover) happens at checkout.

### Phase 4: Charge flow and payment integration

Per Plan §5 final decision: pure charge-first.
- Order is charged at checkout, before any generation runs.
- Order moves to generation_pending status immediately after successful charge.
- Generation queue picks up orders in FIFO order.
- If the order fails to enter the generation queue (system error), refund automatically and notify customer.

### Phase 5: Image pipeline

Per Plan §4.

- Hero page generation:
  - Primary: fal-ai/bytedance/seedream/v4/edit
  - Backup (called only on primary failure): fal-ai/nano-banana/edit
  - Both use the canonical child spec, the source photo, the style anchor, the wardrobe anchor, and the negative prompt guardrails for consistency.
  - If both providers fail on the same hero page after one retry each, the order is escalated to the human queue (per Plan §7).
  - Hard rule: there is no text-only fallback for hero pages on paid orders. If the code path that would do this exists, remove it.
- Non-hero page generation:
  - Static template assets per theme. These are pre-generated, stored, and reused across all orders within a theme.
  - Text overlays (child's name in story text) are rendered server-side onto the static asset, not regenerated.
  - Text-only fallback is permitted for non-hero pages only if the page is non-character (e.g., a landscape, an object) and the resulting page passes the non-hero QA rubric.
- Auto-fail conditions before customer sees proof (per Plan §6):
  - Face count != 1 on any hero page
  - No face detected when a hero page was conditioned
  - Generated garbled text in art where it should not exist
  - Content safety flag (use a basic content classifier)
  - Apparent age clearly outside the structured age band ±3 years
- Auto-fail triggers up to 2 automatic regenerations. After 2, escalate to human queue.

### Phase 6: Proof page and customer approval

Per Plan §5 and Block E decisions.

- Proof page shows:
  - Cover at large size, top of page.
  - Hero spread 1 and hero spread 2 at full size with surrounding text.
  - Thumbnail flipbook of the full book (non-hero pages at small size).
  - Name confirmation in large text: "This book is for: [Name]. Is this correct?" with an inline edit button.
- Three primary actions:
  - Approve and print — moves order to QA queue.
  - Try again — opens the regen flow (Phase 7).
  - Refund my order — opens the refund flow (Phase 8).
- Do not show:
  - Model names ("Seedream," "Nano-banana"), regen counts, internal status, source photo side-by-side comparison.
- Approval is recorded with timestamp on the order record.
- After approval, order moves to QA queue (Phase 9). It is not sent to print yet.

### Phase 7: Customer regen flow

Per Block E decisions.

- Customer clicks "Try again" → modal opens with:
  - Page picker: cover, hero 1, hero 2 (each shown as a thumbnail with checkboxes)
  - "What's not quite right?" — dropdown with options: "Doesn't look like my child / Wrong hair / Wrong skin tone / Weird hands or face / Other" (multi-select) + optional 1-line free text field.
  - Submit button.
- Regen is run on the selected pages with the structured feedback fed into prompt construction.
- After 1st customer regen: show "1 try left" on the proof page next time.
- After 2nd customer regen, the modal becomes:
  "We've tried our best. If you'd like further changes, our team will take a look. Or we can refund your order before printing."
  Buttons: Send to our team / Refund my order
- "Send to our team" moves order to escalation queue. "Refund my order" runs the refund flow.
- Customer regen counter is not visible as a number to the customer (only "1 try left" before the second regen).
- Customer can re-upload a different photo mid-flow. Limit 2 photo swaps per order. Re-upload resets canonical child spec confirmation and regen counter.
- Inactivity timeout: 7 days from proof generation. If no action, auto-refund with notification email.

### Phase 8: Refund flow

Per Plan §8.
- Pre-print refund (proof page button):
  - Single confirmation: "Refund this order? Yes, refund / Cancel"
  - On confirm: refund processed via payment provider within 24 hours.
  - Confirmation email sent immediately.
  - Order status: refunded_pre_print. Photo retention countdown starts (30 days).
  - No email-to-support required. No "are you sure" beyond the single confirmation.
- Post-print: replacement only, manual decision by Alexy via support inbox. Not automated.

### Phase 9: QA queue and admin dashboard

Per Plan §6 and Block D decisions.

- Build admin dashboard with two tabs:
  - QA queue: orders awaiting QA review, sorted FIFO. Each row: order ID, customer name, theme, time-in-queue, [Open] button.
  - Escalation queue: orders in human queue, sorted by escalation_queued_at. Each row: order ID, escalation reason, time-in-queue (with red flag if >12 hours), [Open] button.
- QA review screen for a single order:
  - All hero pages displayed at full size.
  - Source photo and canonical child spec visible for comparison.
  - 10-item hero rubric checklist (per Plan §6):
    1. Name spelling correct everywhere
    2. Skin tone matches photo and structured input
    3. Hair type/color/style matches
    4. Apparent age looks right
    5. Gender presentation matches expectation
    6. No obvious AI artifacts on hero illustrations
    7. Same child across cover + 2 hero pages (manual judgment for v1, no automated similarity check)
    8. Style coherence between hero and non-hero pages
    9. No inappropriate content
    10. Print preflight safe (trim/gutter/bleed/spine)
  - 5-item non-hero rubric checklist (sampled, not exhaustive — reviewer spot-checks 3–5 random non-hero pages):
    1. Name spelling correct in any text
    2. No obvious AI artifacts on any character
    3. Style coherence with hero pages
    4. No inappropriate content
    5. Print preflight safe
  - Three actions: Approve for print / Reject and regenerate / Escalate to manual fix
  - Approval records qa_status = approved, qa_reviewer, qa_timestamp. Order moves to print queue.
  - Rejection runs auto-regen on flagged pages; if already at regen cap, moves to escalation.
- Escalation review screen:
  - All four decision rights available: manual prompt tweak, manual photo crop, manual model swap (Seedream/Nano-banana), refund.
  - 12-hour internal SLA tracker visible.
  - Auto-refund triggers if order is in escalation >72 hours without resolution.

### Phase 10: Print integration

Per Plan §9.

- Lulu integration: order submission API, status webhooks, shipping tracking.
- Hard gate: order does not submit to Lulu unless all of these are true:
  - qa_status = approved
  - customer_approval_timestamp is not null
  - payment_status = captured
- Single trim across formats: 8.5" × 8.5" square.
- Hardcover: casewrap, 80# uncoated white interior.
- Softcover: perfect-bound, 80# uncoated white interior.
- Lower 48 only. AK, HI, PR, APO/FPO, international addresses are rejected at checkout with waitlist email capture.
- No rush shipping option in v1.

### Phase 11: Surge / capacity gating

Per surge plan above.

- Daily order counter: count of orders with qa_status in [pending, rejected_for_regen, escalated] (i.e., orders that still need QA work today).
- Cap: configurable, default 25/day (within the 20–30 range).
- When cap is hit, product page CTA flips to waitlist:
  - CTA: "We're at capacity for this week. Join the waitlist and we'll notify you Tuesday when our next batch opens."
  - Email field, "Join waitlist" button.
  - Confirmation: "You're on the list. We'll email you Tuesday morning when we open this week's batch."
- Tuesday 9am ET: automated notification email to waitlist with link to order. Cap resets.
- Manual override: admin dashboard has a toggle for Alexy to open or close ordering regardless of cap.
- Page content remains visible (photos, examples, copy) — only the CTA is gated.

### Phase 12: Metrics and dashboards

Per Plan §11.
- Build a simple internal page (HTML, no framework needed) at /admin/metrics showing:
  - Pre-print refund rate (rolling 7-day)
  - Post-print refund/replacement rate (rolling 7-day)
  - Average regenerations per order (last 50 orders)
  - QA reject rate (last 7 days)
  - Median + p95 time-to-proof (last 7 days)
  - Median + p95 time-to-ship (last 7 days)
  - Per-book all-in cost (last 7 days, with breakdown: generation, print, labor, refund amortization)
  - FAL endpoint success rate + p95 latency, last 24 hours, both providers
  - Support ticket volume per 100 orders (manual entry by Alexy is fine for v1)
  - Support ticket category breakdown (manual entry)
- Each metric shows current value + threshold + status indicator (green / yellow / red based on kill switch thresholds).
- Real dashboard build deferred to v2.

### Phase 13: Kill switch monitoring

Per Plan §12.

- Background job runs hourly, checks each kill switch threshold against current data.
- If any threshold trips, send alert to Alexy (email + SMS if possible).
- Manual flip: admin dashboard has a "PAUSE ORDERS" button. When pressed:
  - Product page CTA flips to: "We're temporarily paused. Join the waitlist and we'll notify you when we reopen."
  - In-flight orders continue through their existing flow.
  - All metrics continue logging.
  - Resume requires explicit manual action.
- Each kill switch trip is logged with timestamp, threshold, value, and (if resumed) resume timestamp.

### Phase 14: Photo retention enforcement

Per Plan §10.

- Background job runs daily, deletes source photos for orders where:
  - Order shipped >30 days ago
  - photo_retention_opt_in = false
- Deletion log retained (order ID, deletion timestamp) for audit.
- Customers can request earlier deletion via support email; manual delete + confirmation.

## 2. Existing site adjustments

Since HSB has a live site, expect to modify or remove these existing patterns:

- Any existing flow that generates pages on every page of the book per order: rewire to use static template assets for non-hero pages.
- Any existing flow that allows order submission without QA sign-off: add the QA gate.
- Any existing flow that allows shipping without explicit customer approval: add the approval gate.
- Any existing photo upload that doesn't enforce the intake gate: replace with the Phase 2 gate.
- Any existing pricing copy referencing old prices: update to the locked pricing ($14.99 / $39.99 / $59.99).
- Any existing copy promising photo-perfect personalization on every page: replace with the locked product page copy.
- Any existing personalization inputs that are freeform text-heavy: remove or de-emphasize. Keep only the structured fields specified in Phase 3.
- Any existing fallback that silently degrades hero pages to non-personalized content: remove.
- Any existing refund flow requiring email-to-support: replace with on-page 1-click refund (pre-print only; post-print stays manual).

## 3. Test cases

Each phase ships with these acceptance tests passing.

### Happy path
1. Customer uploads valid photo → fills structured inputs → confirms canonical child spec → picks theme and format → checks out and is charged.
2. Generation runs, produces 3 hero pages + non-hero compilation.
3. No auto-fail triggered.
4. Proof page is shown to customer within 24 hours of order.
5. Customer clicks "Approve and print."
6. Order enters QA queue.
7. QA owner approves all 10 hero rubric items + spot-checks non-hero.
8. Order submitted to Lulu.
9. Order ships within 7 business days of customer approval.
10. 30 days post-ship, photo is deleted.

Acceptance: all logging fields populated at each stage.

### Failure path A: photo intake rejection
1. Customer uploads multi-face photo.
2. System rejects with specific error message.
3. Customer is not charged. No order record created.

### Failure path B: hero page auto-fail
1. Order is charged and queued.
2. Seedream returns hero 1 with face count = 0.
3. System auto-regens hero 1 once. Still fails.
4. System swaps to Nano-banana. Generates successfully.
5. Order proceeds normally.

Acceptance: logging shows provider swap and regen count = 1.

### Failure path C: both providers fail
1. Order is charged and queued.
2. Seedream returns hero 2 with no face detected.
3. Auto-regen on Seedream. Still fails.
4. Swap to Nano-banana. Also fails.
5. Order moved to escalation queue.
6. Alexy receives alert.
7. Alexy resolves via manual prompt tweak. Hero 2 generates successfully.
8. Order proceeds to proof page.

Acceptance: escalation logged with resolution timestamp <12 hours.

### Failure path D: customer rejects proof
1. Customer reviews proof, doesn't love hero 1.
2. Clicks "Try again," picks hero 1, selects "wrong hair."
3. Regen runs. New version shown.
4. Customer still unhappy after 2 customer regens.
5. Modal offers "Send to our team" or "Refund my order."
6. Customer picks "Refund my order."
7. Refund processes within 24 hours. Confirmation email sent.

Acceptance: order status = refunded_pre_print, refund timestamp recorded, no email-to-support required.

### Failure path E: kill switch trips
1. Within a 7-day window, post-print refund rate hits 6% (over 20+ orders).
2. Background job detects, sends alert to Alexy.
3. Alexy reviews, presses "PAUSE ORDERS" on admin dashboard.
4. Product page flips to paused state.
5. In-flight orders continue.
6. Alexy diagnoses, fixes, presses "RESUME ORDERS."
7. Resume timestamp logged.

Acceptance: pause event fully logged with trip threshold, resume threshold, and duration.

### Surge path
1. Daily order count hits cap of 25.
2. Product page CTA flips to waitlist state.
3. Subsequent visitors see waitlist, can submit email.
4. Tuesday 9am ET, waitlist email is sent.
5. Cap resets. Orders flow normally.

Acceptance: waitlist emails captured, Tuesday email scheduled, cap correctly enforced.

## 4. Do-not list

These are easy to drift into. Don't.

- Do not add a regenerate option for non-hero pages. Non-hero pages are static template assets per theme.
- Do not show model names, regen counts (as numbers), or internal order status to the customer.
- Do not add an are-you-sure confirmation modal beyond a single yes/no on the refund button.
- Do not auto-approve any order at QA. Every order requires explicit reviewer action.
- Do not allow print submission to Lulu without all three gates (QA approval, customer approval, payment captured).
- Do not add features not specified in the plan: no subscriptions, no series, no upsells, no gift wrap, no gift messages, no rush shipping, no multi-child books, no international shipping.
- Do not introduce a preview step before charge. The plan is pure charge-first.
- Do not add automated face-similarity checking in v1. Manual reviewer judgment only.
- Do not silently retry endlessly on FAL endpoint failures. Cap is 1 retry per provider, then swap, then escalate.
- Do not store photos beyond 30 days post-ship without explicit opt-in.
- Do not allow more than 2 customer regens or more than 2 photo swaps per order.

## 5. Definition of done for v1

The build is ready for soft launch when all of these are true:
- All 14 phases are implemented and tested.
- All test cases above pass.
- 10 internal end-to-end test orders completed, including 2 forced-failure-path runs (force a Seedream failure, force a both-provider failure).
- 20-book diverse-subject Lulu print test completed; physical books reviewed and approved.
- FAL load test completed for both Seedream and Nano-banana at 20 concurrent requests each.
- Kill switch alerting verified by intentionally tripping a low-bar threshold.
- Admin dashboard accessible to Alexy with QA queue and escalation queue functional.
- Metrics page populates with real data.
- Photo retention deletion job verified on a test order.
- Pricing copy, refund/regen copy, SLA copy, and photo retention copy all live and matching plan §15.
- Public product page headline and subhead match locked copy.
- Waitlist surge state tested and functional.

If any one of these is not true, do not open ordering — even invite-only.

## 6. Open dependencies on Alexy (not Claude Code)

These are decisions and actions that block launch but are outside the build:

- Get Lulu quote in writing: per-unit hardcover + softcover cost, reject/reprint terms, p50/p95 SLA, shipping by zone.
- Confirm Lulu print SLA fits inside the customer-facing "ships in 7 business days" promise with reprint contingency buffer.
- Run the 20-book diverse-subject print test with Lulu.
- Recruit at least 5 friends-and-family parents for pre-launch test orders.
- Confirm payment processor supports 1-click refund flow with 24-hour processing.
- Confirm email infrastructure for proof-ready, refund-confirmation, waitlist-Tuesday, and inactivity-auto-refund emails.

---

# Handoff to Rex

The implementation guide above is structured to be reviewed and improved before handoff to code. When you send it to Rex, I'd suggest framing the review request as:

"Review this implementation guide for the HSB launch. Source-of-truth plan is in the linked file. Look for: (1) ordering errors where Phase N depends on Phase N+1, (2) ambiguities Claude Code could interpret freely, (3) missing test cases for failure paths, (4) anything in the existing site that conflicts with the build that I haven't flagged, (5) anything in the do-not list that should be there but isn't."

That framing focuses Rex's review on the same dimensions I'd want a second pair of eyes on — sequencing, ambiguity, coverage, integration with what already exists, and guardrails.

If Rex flags changes you accept, drop them back to me and I'll update the implementation guide. If Rex flags changes you're unsure about, walk me through them and I'll give you a blunt view on whether to incorporate.

One thing I'd specifically ask Rex: "Given the existing site at www.herostorybooks.com, what's the cleanest way to stage these changes — branch off main and migrate, or feature-flag the new flow alongside the old?" That's a deployment-strategy question that depends on your existing infrastructure, and it's the one decision I genuinely don't have enough information to make for you.
