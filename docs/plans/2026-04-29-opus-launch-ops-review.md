# Opus Launch Ops Review

# Overall verdict

The plan is operationally viable only as a tightly constrained soft launch with mandatory human QA on every order. Without those two constraints, it isn't a launch plan — it's a wager. The good news is that the constraints are cheap to implement and don't require any technical rebuilds. The bad news is that "we'll add QA later when we scale" is the failure mode that kills companies in this category, and skipping it now to save a part-time role is the single dumbest possible economy.

# What is operationally sound

- Human QA is in the plan. Acknowledging this upfront is most of the battle.
- Forbidding silent text-only fallback on hero pages for paid orders. Correct and non-negotiable.
- Dual model routing (Seedream → Nano-banana). Gives you a real fallback that doesn't compromise the product promise.
- Narrow launch scope (2 templates, 3 personalized touchpoints). Smaller surface area = smaller QA load = fewer failure modes.
- Avoiding a local face-adjustment pipeline as a blocker. Right call. That's a post-PMF problem.
- Acknowledging fulfillment is more than software. Most teams in this category miss this entirely.

# What is operationally dangerous

- No defined QA rubric or QA owner. "Human QA" without a checklist and a named person is a wish, not a process.
- No defined behavior when both Seedream and Nano-banana fail or produce garbage. This will happen. What's the order's path? Queue? Refund? Manual? Undefined = panic decision under support pressure.
- No order-flow decision on charge timing. Charging before preview vs. after preview is the single biggest operational lever you have on refund risk and you haven't picked one.
- No defined turnaround SLA, no print partner, no print QC. This is half your unit cost and 100% of your gift-occasion risk and it's invisible.
- No per-order data capture spec. When something goes wrong, you need source photo + structured inputs + prompt + model + seed + outputs + QA decision + regenerations, all linked. Without this you can't diagnose, improve, or defend yourself.
- No regeneration cap. Without one, a small number of unhappy customers will consume disproportionate ops time and generation cost.
- No cost-per-book ceiling with alerting. Silent margin erosion via "just one more regen" is invisible until you reconcile the FAL bill.
- No defined escalation path from automated pipeline → human queue. Who picks up the ticket? In what tool? With what SLA?
- No COPPA/photo retention policy. Storing children's photos without a defined retention and deletion policy is a slow-burning legal and PR risk.
- No load test of FAL endpoints. "It works in dev" is not the same as "it works at 30 concurrent orders on a Saturday morning."

# What I would require before launch

1. A named QA owner and a written 5-item QA rubric. Not a Slack message, a document. One person responsible per shift. No order ships without their sign-off.
2. A pre-charge digital preview gated on parent approval. Charging before the parent sees the preview is the single largest unforced refund risk available, and the only argument for it is conversion, which you can't afford to optimize for in week 1.
3. A defined fallback chain with a human-queue terminus. Seedream → Nano-banana → human queue. Never → text-only fallback for a paid order. Never → ship anyway.
4. A regeneration cap of 2 automatic + 2 customer-requested, then escalation. Hard cap. No exceptions in v1.
5. A per-book all-in cost ceiling with alerting when an individual order exceeds it. Suggested starting point: $6 generation + $12 print + $4 QA labor = $22 floor, $50 retail.
6. A turnaround SLA you can hit 95% of the time including QA queue time and print partner SLA. Promise it on the product page. Suggested: 7-10 business days for v1.
7. Per-order logging: source photo, structured inputs (name, age, pronouns, hair, skin tone), prompt, model, seed, all outputs, QA decision, regeneration count, all linked by order ID.
8. Print partner selected, contracted, and tested with at least 20 books across diverse subjects before opening orders.
9. A written photo retention and deletion policy: delete source photos N days after fulfillment unless customer opts in. 30 or 60 days is fine; "undefined" is not.
10. A load test of both FAL endpoints at 5x your expected peak concurrent volume. If either falls over, you need to know now.

# QA checklist essentials

The reviewer checks every order on these, in this order, every time:

- Name spelling correct in every place it appears in the book. (This is #1 because it's the most embarrassing and the easiest to catch.)
- Skin tone matches the source photo and the parent's stated description.
- Hair type, color, and style match — including textured hair, head coverings, and any specifics the parent provided.
- Apparent age looks right. No 4-year-olds rendered as 8-year-olds.
- Gender presentation matches what the parent indicated.
- No obvious AI artifacts in any hero illustration: extra fingers, missing limbs, melted features, uncanny eyes, garbled in-illustration text.
- Same child across cover + 2 interior heroes. Not identical, but recognizably one person.
- Style coherence between hero pages and template pages. No jarring stylistic jumps.
- No inappropriate content in any illustration. Rare but a single instance is catastrophic; the check costs nothing.
- Print pre-flight: key elements not in trim/gutter, faces not crossing the spine, text not in the bleed.

Automatic fails before the proof reaches the customer:

- Face count != 1 in any hero illustration.
- Detected age delta > 3 years from stated age.
- No face detected when one was conditioned for.
- Generated text characters appearing in artwork that aren't intentional.
- Any output flagged by a basic content classifier.
- Any output where the cover and interior heroes have a face-similarity score below threshold (you'll need to set this empirically).

# Regeneration / escalation policy
- 2 automatic regenerations if the pipeline detects a hard failure (auto-fail conditions above). Silent to the customer.
- 2 customer-requested regenerations of hero pages if the parent doesn't love the proof. Free, no questions asked, framed as generosity.
- After 4 total regenerations on a single order, escalate to human. Manual prompt tuning, manual photo review, or refund. No more automatic loops.
- Non-hero pages are not regenerated. Frame as "the illustrated story." This is the single most important boundary in the policy.
- Name spelling errors are corrected, not regenerated. Different process — text fix, not model fix.
- If both Seedream and Nano-banana fail on the same hero page twice, escalate immediately to human queue. Don't keep retrying a broken endpoint.
- Customer never sees regeneration counts or model names. Internal only. Customer sees "Not quite right? We'll try again."
- Hard cap: any order open for >72 hours in regeneration loop gets manual intervention or refund. No order should sit in limbo over a weekend.

# Refund / support policy recommendation

- Full refund before print, no questions asked, if the parent doesn't approve the proof. Single most trust-building policy you can have. Costs you only generation $$, not print and shipping.
- Replacement (not refund) for post-print quality issues: print defects, shipping damage, your-fault errors like a name misspelled despite being confirmed correctly in the proof. Replacement is cheaper and feels more caring.
- No partial refunds. "I sort of like it" is not a refund category. Either approve, regenerate, or full refund. Partial refunds train customers to negotiate.
- 2 free hero-page regenerations before printing. Bounded, generous, and bakeable into pricing.
- Policy stated plainly on the product page, not buried in FAQ. "Preview before you pay. Two free do-overs. Full refund if you don't love the proof. Replacement if anything's wrong with the printed book." Visible policy is itself a trust signal.
- One support inbox, one human checking it, with a 24-hour response SLA published on the contact page. At launch volume, this is one part-time role.
- Refund decisions made by one named person, not by a committee or a flowchart. At low volume, judgment is faster and better than rules.
- Bake refund/regeneration cost into pricing. Plan for 30-40% regeneration rate and 5-10% pre-print refund rate. If reality is better, that's margin, not surprise.

# Print safety recommendation

- No book prints without QA sign-off in the order record. Hard system gate, not a process norm.
- Customer must explicitly approve the digital proof before the print job is sent. Approval is logged with timestamp.
- Name spelling re-confirmed at the approval step — large text, top of the proof page, "This book is for: ___. Is this correct?"
- Print partner has a defined reject-and-reprint policy for muddy print, color drift, binding defects, and trim errors. You should know these terms before you ship one book.
- Order at least 20 finished books to yourselves before opening to customers — across diverse skin tones, hair types, ages, and both templates. Hold them. Photograph them. Use them for marketing. Reject the print partner if any consistently come out badly.
- Print is soft-launched later than digital is acceptable, but only if you don't charge gift-level prices for digital. A $40 product needs to be a physical book.
- Color and saturation calibration check on every print partner change or paper change. Screen-to-print drift is a reliable surprise.
- No same-day or 1-day rush printing in v1. It removes your QA buffer and your reprint buffer, and it's the highest-risk SKU for the lowest marginal revenue.

# Metrics to watch daily
- Pre-print refund rate (parent didn't approve proof). Healthy if low; if very low, your preview isn't honest enough.
- Post-print refund/replacement rate. Anything >5% is a serious problem; investigate every instance.
- Regenerations per order (automatic + customer-requested). Trend matters more than absolute number.
- QA reject rate at the human-review gate. If it's >20%, your auto-fail logic is letting too much through. If it's <2%, your reviewer might be rubber-stamping.
- Median and p95 time-to-proof from order placement.
- Median and p95 time-to-ship from proof approval.
- Per-book all-in cost (generation + print + labor + refunds amortized). Watch the trend, not just the average.
- FAL endpoint success rate and latency for both Seedream and Nano-banana. Separately.
- Support ticket volume per 100 orders and median resolution time.
- Support ticket category breakdown — likeness, name, print, shipping, other. Tells you where to invest next.
- Promoter signal — informal at this stage. "Would you order again?" in a follow-up email after delivery. n=20 tells you a lot.

# Kill switch criteria

Pause taking new live orders if any of these hit during the launch window:

- Any single instance of a paid order shipping with a hero page that wasn't actually personalized (text-only fallback or template fallback in a hero slot). Pause on n=1. This is severe.
- Any complaint involving ethnicity, skin tone, or hair misrepresentation that wasn't caught by QA. Pause on n=1. Reputational, not statistical.
- Any inappropriate or unsafe content reaching a customer's proof. Pause on n=1.
- Post-print refund/replacement rate >5% over a rolling 7-day window with at least 20 orders.
- Pre-print proof rejection rate >25% over a rolling 7-day window. Means the pipeline is producing junk faster than QA can catch it.
- QA reject rate >20% at the human gate over 3 consecutive days. Means the upstream pipeline is unhealthy.
- Median time-to-proof exceeds 24 hours for 3 consecutive days. Means you're buried.
- Median time-to-ship exceeds your SLA by >20% for 3 consecutive days.
- Per-book all-in cost exceeds ceiling by >25% for a full week.
- Either FAL endpoint success rate <90% for 24 consecutive hours.
- Support ticket volume >25% of order volume for 3 consecutive days. Means something systemic is wrong, not a few unhappy customers.

When a kill switch trips: stop accepting new orders, complete in-flight orders, diagnose, fix, then resume. Don't keep selling while you debug.

# Soft launch recommendation

Yes — emphatically yes. Quiet soft launch only.

- Invite-only or unlisted product page for the first 2-4 weeks. No paid promo, no PR, no press, no influencer push.
- Friends-and-family + a recruited cohort of 50-100 parents at a discount in exchange for honest feedback and permission to use their reactions in marketing.
- Cap daily order volume at what one human QA reviewer can clear in a workday. Suggested: 10-20 orders/day for week 1, 30-50/day for weeks 2-4, then re-evaluate.
- Single template at first, second template added in week 2 or 3 once the first one is clearing QA cleanly.
- Single format (one cover style, one trim size, one paper). Variants come later.
- Single age band (e.g., ages 3-6). Older and younger expand the prompt and template space and add QA variance.
- One country / one currency for shipping in v1. International shipping doubles ops complexity for marginal revenue.
- No rush shipping options in the soft-launch window.
- No gift wrap, no gift messages, no add-ons in v1. Each one is a separate failure mode.
- No subscriptions, no series, no second-book discounts until you've shipped 200 first books cleanly.
- Public launch only after: 100+ orders shipped, post-print refund rate <3%, no kill switch tripped for 14 consecutive days, and at least 10 customer-photographed-in-the-wild testimonials in hand.

# Hard truth
The single most uncomfortable operational truth is that you are launching a manual operation disguised as an automated product, and the manual labor — one human looking at every proof — is the most important and least glamorous part of the entire system. Every instinct on the team will be to optimize, automate, or eliminate that step, because it feels like it doesn't scale and like it's not "real engineering." But for the first few hundred books, the human reviewer is not a temporary cost to minimize — they are the product. The companies in this category that succeed treat that role as a craft and staff it accordingly. The ones that fail treat it as a placeholder for automation that isn't ready yet, ship inconsistent quality, and burn through trust faster than they can rebuild it. Decide now whether you're running a manual operation that uses AI, or an AI product with a QA afterthought, because the customer experience of those two things is not the same.
