# HSB Final Consolidated Launch Plan

> For Hermes: use this as the source-of-truth plan before writing the final Claude implementation prompt.

Goal: Launch Hero Story Books safely and soon with a product that feels personalized and gift-worthy, while controlling fulfillment cost, avoiding embarrassing outputs, and preserving customer trust.

Architecture: Use template-driven, picture-first books with selective strong personalization on the pages that matter most. Keep human QA in the loop for every paid order. Treat launch as a tightly constrained soft launch, not a fully automated scale system.

Tech Stack: Existing HSB checkout/order/fulfillment stack, FAL image providers, proof/review flow, print fulfillment path, admin/diagnostics surfaces.

---

## 1. Launch posture

This is a soft launch.

Do not treat v1 as a fully automated AI book factory.
Treat it as:
- a manual operation powered by AI
- with hard QA gates
- bounded regeneration
- explicit proof approval before print
- strict failure handling

Hard truth:
- for the first few hundred books, the human reviewer is part of the product
- removing or minimizing that role too early is the fastest way to burn trust

---

## 2. Final v1 product scope

### Catalog scope
Launch with the current 6 themes unless testing proves one is materially worse:
- Brave Explorer
- Space Voyager
- Ocean Dreams
- Dragon Quest
- Royal Adventure
- Dinosaur Discovery (if present in the launch branch/product set)

But operate them under one shared system:
- fixed page beats per theme
- same hero-page rules
- same fallback rules
- same QA rubric
- same proof/review process

If one or more themes are materially worse in testing:
- cut Mother’s Day / Father’s Day occasion variants first
- then cut the weakest evergreen theme(s)
- strongest cut candidates if needed are Royal first, then Dragon

### Personalization scope
Per book, strongly personalize only:
- cover
- hero spread 1
- hero spread 2

Optional later, not required for v1:
- final celebration page

Non-hero pages:
- template-led
- picture-first
- less exact-likeness-dependent
- no customer-visible claim that every page has the same level of face fidelity

### Input scope
Required customer input:
- child photo
- child name
- theme
- format
- email

Optional structured input only:
- age bucket
- pronouns / gender presentation signal
- skin tone / hair / notable traits if collected
- occasion preset
- lesson preset

Do not require freeform customer writing.
Remove or de-emphasize dedication/gift-message dependence.

---

## 3. Customer promise

Sell this as:
- a beautifully illustrated personalized storybook
- with your child as the hero
- inspired by their photo

Do not sell it as:
- perfect photographic fidelity on every page
- full exact face cloning throughout the whole book
- fully custom-authored page-by-page customer-written story

Expectation setting must be honest.
The cover and hero pages carry the “wow” factor.
The rest of the book carries story coherence and visual charm.

---

## 4. Image pipeline rules

### Photo-conditioned routing
For hero pages with a usable reference photo:
1. primary: `fal-ai/bytedance/seedream/v4/edit`
2. backup: `fal-ai/nano-banana/edit`
3. if both fail: escalate to human review

Hard rule:
- no silent text-only fallback on paid hero pages
- no “ship anyway” behavior

### Non-hero routing
For non-hero pages:
- allow the cheaper/stabler generation lane
- allow text-only fallback if the resulting page still meets QA standards
- keep this invisible to the customer

### Canonical child spec
Before generating hero pages, derive and freeze a per-order identity spec to reuse across all hero prompts:
- apparent age band
- skin tone
- hair color
- hair texture/style
- glasses / notable features
- pronouns or gender presentation signal if collected
- cultural/religious headwear if visible/relevant

Every hero page must use the same frozen child spec.
Do not let each page invent the child from scratch.

### Hero-page consistency rules
All hero pages should reuse:
- the same child reference photo
- the same canonical child spec
- the same style anchor
- the same wardrobe anchor unless the scene requires a justified change
- the same negative prompt guardrails

### Data capture per page
Persist for each generated page:
- page type: hero vs non-hero
- provider used
- exact model used
- conditioning mode
- fallback path taken
- regeneration count
- manual review flag

---

## 5. Proof and charge timing

Preferred v1 policy:
- preview before charge
- parent approves the proof
- only then does the print/payment step finalize

Reason:
- lowest refund and support risk
- best trust posture for week 1

If preview-before-charge is too heavy to implement immediately, the fallback v1 policy is:
- charge first
- generate proof before print
- allow 2 free hero-page regenerations
- full refund before print if the parent does not approve

But the preferred choice for this plan is:
- pre-charge preview gated on approval

Either way:
- no print without explicit parent approval
- approval must be logged with timestamp
- approval screen must re-confirm the child name visibly

---

## 6. QA ownership and QA rubric

### Ownership
There must be:
- a named QA owner
- one human responsible for sign-off per shift/day
- no order prints without QA sign-off in the order record

### Minimum QA rubric
Reviewer checks every order in this order:
1. Name spelling correct everywhere
2. Skin tone matches photo and structured input
3. Hair type/color/style matches, including textured hair and headwear
4. Apparent age looks right
5. Gender presentation matches expectation
6. No obvious AI artifacts in hero illustrations
7. Same child across cover + 2 hero pages
8. Style coherence between hero and non-hero pages
9. No inappropriate content
10. Print preflight safe: trim/gutter/bleed/spine safe

### Automatic hard-fail conditions before customer sees proof
- face count != 1 on any hero page
- no face detected when a hero page was meant to be conditioned
- age delta clearly beyond threshold
- generated garbled text in art where it should not exist
- content safety flag
- hero-page similarity below threshold once threshold is established empirically

---

## 7. Regeneration and escalation policy

### Automatic pipeline behavior
- 2 automatic regenerations if a hard-fail condition is hit
- if Seedream and Nano Banana both fail on the same hero page, escalate immediately
- no endless loops

### Customer-visible behavior
- 2 customer-requested hero-page regenerations max, free
- phrase simply: “Not quite right? We’ll try again.”
- do not expose model names or regen counts to the customer

### Hard caps
- after 4 total regenerations on an order: human queue, manual intervention, or refund
- any order stuck >72 hours in regen limbo gets manual action or refund

### Boundaries
- non-hero pages are not endlessly regenerated
- name spelling corrections are text fixes, not art regens

---

## 8. Refund and support policy

### Refund policy
- full refund before print if the parent does not approve the proof
- no questions asked
- no partial refunds in v1

### Post-print policy
- replacement, not refund, for:
  - print defects
  - shipping damage
  - our fault errors that passed approval incorrectly

### Support policy
- one support inbox
- one named person monitoring it
- 24-hour response SLA published
- refund decisions owned by one person, not a committee

### Cost assumptions
Bake into economics:
- meaningful regeneration rate
- pre-print refund rate
- QA labor cost
- do not pretend these are edge cases

---

## 9. Print safety and fulfillment rules

Before launch:
- select print partner
- test at least 20 finished books across diverse subjects
- hold physical copies
- review color, binding, trim, bleed, face rendering, and overall gift feel

Hard print rules:
- no book prints without QA sign-off
- no book prints without explicit customer approval
- no rush printing in v1
- no print fulfillment if the proof is not gift-worthy

Print can be delayed relative to digital if needed,
but do not charge gift-level expectations without a trustworthy print path.

---

## 10. Logging, diagnostics, and data retention

### Per-order logging required
Persist and link by order ID:
- source photo reference
- structured child inputs
- prompt(s)
- model(s)
- seed(s) if available
- outputs
- QA decision
- regeneration count
- approval timestamp
- refund/replacement outcome if any

### Data retention
Define and publish a photo retention/deletion policy:
- delete source photos after a defined post-fulfillment window unless opt-in exists
- 30 or 60 days is acceptable
- undefined is not acceptable

---

## 11. Metrics to watch daily

Track daily during soft launch:
- pre-print refund rate
- post-print refund/replacement rate
- regenerations per order
- QA reject rate
- median and p95 time-to-proof
- median and p95 time-to-ship
- per-book all-in cost
- FAL endpoint success rate and latency for both providers
- support ticket volume per 100 orders
- support ticket category breakdown
- simple promoter signal / reorder willingness

---

## 12. Kill switches

Pause taking new live orders if any of these happen:
- any paid order ships with an unpersonalized hero page
- any ethnicity / skin tone / hair misrepresentation missed by QA reaches customer
- any inappropriate or unsafe content reaches customer proof
- post-print refund/replacement rate exceeds threshold
- pre-print rejection rate indicates junk output trend
- QA reject rate stays too high over multiple days
- median time-to-proof exceeds 24 hours for multiple days
- median time-to-ship exceeds SLA materially
- per-book cost ceiling materially exceeded over time
- either FAL endpoint health degrades below acceptable threshold
- support volume becomes systemic rather than isolated

When triggered:
- stop accepting new orders
- finish in-flight orders
- diagnose
- fix
- resume only after stability

---

## 13. Soft launch limits

Soft launch only.

Recommended limits:
- invite-only / unlisted product page first
- no paid promo initially
- capped daily order volume based on one QA reviewer’s capacity
- single print format in v1
- no rush shipping
- no gift-wrap/add-on complexity
- no subscriptions/series/upsells yet
- public launch only after a clean soft-launch window

---

## 14. Immediate implementation priorities

Before final Claude prompt, the implementation plan should reflect these priority decisions:
1. make Seedream v4 Edit primary and Nano Banana Edit backup
2. hard-code hero-page vs non-hero behavior
3. forbid silent hero-page text-only fallback on paid orders
4. add canonical child spec reuse across hero pages
5. add per-page provider/model metadata persistence and diagnostics
6. add QA sign-off and approval gating requirements into order flow/admin state
7. add regeneration cap / escalation hooks
8. remove or de-emphasize text-heavy filler inputs
9. keep the book picture-first
10. preserve current theme catalog unless testing proves a theme should be cut

---

## 15. Final recommendation

Launch smaller, more honestly, and with more human control.

The right v1 is:
- soft launch
- picture-first template-driven books
- strong personalization on cover + 2 hero pages
- human QA on every order
- explicit approval before print
- bounded regenerations
- clear refund rules
- strong diagnostics and kill switches

If we cannot support that operationally, we are not ready to launch.
