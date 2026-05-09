# Opus Final Review on Consolidated HSB Launch Plan

# Overall verdict

The plan is dramatically better than the starting position and most of the right ideas are now in writing. But it has two structural problems that will hurt you if you hand it to Claude Code as-is: charge timing is undecided (which cascades into refund logic, regen logic, and order-state machine design), and scope is still wider than your QA capacity will support on day one (6 themes, 2 hero spreads, occasion variants implied). There are also several "define this empirically later" placeholders that need concrete numbers before code is written, or Claude will either pick them itself or leave them as TODOs that ship to production. Lock the open decisions, narrow scope by one notch, and this is implementable.

Tracing two customer paths through the plan to surface seams:

- Happy path: parent uploads photo → canonical child spec frozen → 3 hero pages generate cleanly → proof shown → parent approves → QA sign-off → charge → print → ship. Seam problem: the plan says "preview before charge" preferred, "charge first" fallback, but never resolves which one v1 ships with. The order state machine, the refund flow, and the regen flow all depend on this answer. Claude Code cannot build this without picking, and you don't want Claude picking.
- Failure path: parent uploads photo → Seedream fails on hero 1 → Nano-banana fails on hero 1 → escalation. Seam problem: the plan says "escalate to human review" but doesn't define what the human reviewer's tools, queue, SLA, or decision rights are. Section 7 says "human queue, manual intervention, or refund" — that's three options, no rule for picking. In practice this becomes "ping the QA owner in Slack and hope," which is exactly the hidden manual chaos you said you wanted to avoid.

# What is solid

- Launch posture framed as a manual operation powered by AI, not an automated factory. This single framing decision makes the rest of the plan coherent.
- Hero-page rules are tight: no silent text-only fallback on paid orders, dual-model routing with explicit human escalation as terminus.
- Canonical child spec idea (Section 4) is the right answer to the consistency problem and is now explicit.
- QA rubric is concrete and ordered. A reviewer can actually use it.
- Auto-fail conditions are crisp enough that an engineer can implement most of them directly.
- Regeneration caps are numbered (2 auto + 2 customer + 4 total + 72-hour limbo cap). Bounded ops burden.
- Refund policy is plain and honest. "Full refund before print, no partial refunds, replacement for post-print issues" is a clean three-line policy.
- Per-order logging spec is detailed enough to implement.
- Kill switches exist as a category, even if some thresholds need numbers.
- Print partner is gated by a 20-book test. Correct.
- Soft launch posture with capped daily volume tied to one reviewer's capacity. This is the right operational shape.

# What is still unclear or contradictory

- Charge timing is undecided. Section 5 names "preview before charge" as preferred and "charge first + refund before print" as fallback, but never picks. Every downstream system (order state, refund flow, regen flow, customer comms, accounting) is shaped by this choice. This is the single biggest unresolved decision in the plan.
- Theme scope contradicts QA capacity. Section 2 says "launch with current 6 themes." Section 13 says "capped daily order volume based on one QA reviewer's capacity." Six themes × two hero spreads + a cover means the QA owner has to internalize the page beats and visual style for 6 different stories. That's slower per-review and more error-prone, especially in week 1. The plan also mentions "Mother's Day / Father's Day occasion variants" as cuttable — implying they currently exist, which silently expands scope further.
- Section 14 (#10) says "preserve current theme catalog unless testing proves a theme should be cut." This puts the burden of proof on cutting rather than on keeping. With one QA reviewer, the burden should run the other way: prove a theme is ready, don't prove it's broken.
- "Empirically later" placeholders. "Hero-page similarity below threshold once threshold is established empirically" (Section 6) and "age delta clearly beyond threshold" (Section 6) are not implementable as written. Claude Code will either invent numbers or leave a TODO. Pick numbers now, even if you tune them later.
- Kill switch thresholds are mostly verbal. "Exceeds threshold," "indicates junk output trend," "stays too high over multiple days," "materially exceeded." The earlier rounds had concrete numbers (>5%, >25%, >20% for 3 consecutive days, etc.). They got softened in consolidation. A kill switch without a number is not a kill switch.
- Cost ceiling is referenced but never set. Section 8 says "bake into economics" and Section 11 says track "per-book all-in cost," and Section 12 says pause if "per-book cost ceiling materially exceeded" — but no ceiling number appears anywhere in the document.
- Turnaround SLA is never specified. Section 11 tracks p95 time-to-proof and time-to-ship, Section 12 trips on "exceeds SLA materially," but no SLA is stated. What does the customer see on the product page? Unanswered.
- "Fallback v1 policy" language in Section 5 is dangerous. It tells the implementer "if the preferred is hard, do the fallback." That's a decision the implementer will make under deadline pressure, not a decision you make deliberately. Pick one, kill the other.
- Non-hero "text-only fallback if it meets QA standards" (Section 4) is a soft seam. What does "meets QA standards" mean for a non-hero page? The QA rubric in Section 6 is hero-focused. Define the non-hero standard or it becomes reviewer judgment in the moment.
- Escalation path destination is undefined. "Human queue" appears repeatedly but is never an actual system. Where does the escalation land — an admin dashboard, an email, a Linear ticket, a Slack channel? Who picks it up? What's the SLA?
- QA "per shift/day" ownership (Section 6) implies multiple shifts and a handoff process, but the rest of the plan reads as one reviewer. Pick one — single owner with capped daily volume, or shift system with handoff protocol. Don't leave both implied.
- No Section 10 retention number. "30 or 60 days is acceptable, undefined is not." This is itself undefined. Pick 30 or 60.
- The "approval screen must re-confirm the child name visibly" is in Section 5, but name-spelling correction as a text fix (Section 7) and name spelling as QA item #1 (Section 6) imply three different places name correctness is enforced. Define the canonical flow: where is the name first confirmed, where can it be corrected, what happens to in-flight generations when it's corrected.

# What is still too risky

- Six themes on day one with a single QA reviewer. Each theme adds visual variance the reviewer has to hold in their head. You are likely to ship inconsistent quality across themes simply because one reviewer can't equally master all six in week 1.
- Two hero interior spreads + cover (= 3 personalization checkpoints) is at the upper limit of what current photo-conditioning can hold consistent. The earlier round suggested cutting to cover + 2 (which this is) or cover + 1. With 6 themes, I would seriously consider cover + 1 hero for v1. You can add the second hero back per-theme as each proves itself.
- No defined per-book cost ceiling means margin can erode invisibly through regen loops and FAL price changes. The kill switch can't trip on a number that doesn't exist.
- Print partner not yet selected at the time this plan is written, but the plan also says "no charge gift-level expectations without trustworthy print path." These two facts together mean the launch can't happen until the print partner test is done. Make that dependency explicit in the timeline or it'll get skipped.
- No load test of FAL endpoints is mentioned. "FAL endpoint success rate and latency" is a daily metric (Section 11) and a kill switch trigger (Section 12), but you have no baseline because you haven't tested it under realistic concurrency. The first time you discover Seedream's behavior at 20 concurrent edits should not be on a Saturday morning during launch.
- Customer-side regeneration UI is not designed. "Not quite right? We'll try again" is the copy, but the actual flow — what does the parent see, do they pick which page, how do they describe what's wrong, do they get the same image back if they don't change anything — is unspecified. This is a customer-facing surface that will get built freehand if Claude Code touches it without a spec.
- Photo intake quality control is missing entirely. The plan requires a child photo as input but specifies no quality gate (resolution minimum, single face, front-facing, automatic rejection of obvious failures). Garbage photos will produce garbage hero pages that the auto-fail logic can't always catch. This was flagged hard in earlier rounds and didn't make it into the consolidated plan.
- The "structured input only" list in Section 2 marks skin tone / hair / traits as optional. But the canonical child spec in Section 4 requires them. If a customer skips them, what populates the spec — model inference from the photo? That's exactly the failure mode (skin tone drift, hair misread) that earlier rounds flagged as the biggest reputational risk. Either make them required or define explicitly how the spec gets filled when they're missing.

# What I would lock before implementation

In priority order — these are the decisions Claude Code cannot make for you:
1. Pick charge timing. Preview-before-charge or charge-first-with-pre-print-refund. One sentence. Everything downstream depends on it. Recommendation: preview-before-charge. The conversion lost is the refund risk avoided, and at soft-launch volume conversion isn't the bottleneck — trust is.
2. Lock theme count for v1. Recommendation: launch with 2 themes, not 6. The other 4 stay in the codebase but are not orderable until each clears a per-theme readiness checklist (20 test books reviewed, QA owner can apply rubric cleanly, prompt template stable). This is the single largest scope reduction available and it doesn't require any rebuild.
3. Lock hero count per book. Cover + 1 interior hero, or cover + 2. Recommendation: cover + 1 for v1, given the QA reviewer load and the 6→2 theme cut buying back some quality budget. Add the second hero back theme-by-theme as it proves stable. If you keep cover + 2, lock it explicitly and price for it.
4. Set the per-book cost ceiling. A number. E.g. $6 generation, $12 print, $4 QA labor → $22 cost floor against $50 retail. Whatever the numbers actually are, write them down. The kill switch needs a number to trip on.
5. Set the turnaround SLA. A number. "Ships in 7 business days" is a reasonable starting point. Publish it on the product page. The kill switch needs this too.
6. Set the kill-switch thresholds in numbers, not adjectives. Pull the concrete numbers from the prior round (>5% post-print refund, >25% pre-print rejection, >20% QA reject for 3 consecutive days, etc.) and put them back in. "Materially" is not a threshold.
7. Set the auto-fail thresholds in numbers. Age delta in years. Hero-page face-similarity threshold (you can pick 0.6 as a starting cosine similarity and tune; the point is to have a number, not to have the right number). Without these, Section 6 isn't implementable.
8. Set the photo retention number. 30 days or 60 days. Pick.
9. Make structured fields (skin tone, hair, age) required, not optional. Use dropdowns with picker images so it's two clicks, not a writing task. If they're optional, you've reintroduced the model-infers-ethnicity failure mode through the back door.
10. Define the photo intake gate. Minimum resolution, single face required, automatic rejection on multiple faces / no face / extreme angle, on-screen examples of good vs. bad photos at upload. This is the cheapest quality lever you have and it's missing.
11. Pick a single QA ownership model. One named owner, capped daily volume, no shift handoff in v1. Or define the handoff protocol. Don't leave both implied.
12. Define the "human queue" as an actual system. What tool, what fields, what SLA, what decision rights. Even if it's "an admin page that lists escalated orders with a 4-hour internal SLA and the QA owner is the sole decider," write that down.
13. Pick the print partner before coding starts, or explicitly mark print integration as a separate workstream that can't gate digital implementation. Don't let this become discovered work in week 3.
14. Run the 20-book print test before opening orders to anyone. Add this as a launch-blocking checklist item, not a recommendation.
15. Write the customer-side regen flow spec. One screen, what's on it, what the parent does, what gets re-generated, what doesn't, where the regen counter is tracked. Two paragraphs is enough; zero paragraphs is not.

# What to cut or narrow

- 6 themes → 2 themes for v1. This is the highest-leverage cut. Other themes ship per-theme as they prove ready. Each new theme is a release, not a launch-day deliverable.
- Cover + 2 heroes → Cover + 1 hero for v1 (recommendation, not requirement). If you keep 2, accept that QA load roughly doubles per book.
- Mother's Day / Father's Day occasion variants → cut from v1 entirely. They expand the prompt and template surface for marginal gift-occasion lift. Add later.
- "Optional later" celebration page personalization → remove from the plan entirely until v1 ships. Optional-later items are scope creep magnets.
- The "fallback v1 policy" in Section 5 → delete. Pick one charge-timing model and write only that one.
- Non-hero text-only fallback "if it meets QA standards" → narrow to specific allowed cases (e.g. "non-hero page where the illustration is a non-character scene") or remove the carve-out.
- Multi-format / hardcover-and-softcover → single format for v1. Section 13 already says single format; make sure the implementation reflects it and the product page doesn't show options.
- Subscriptions, series, gift wrap, gift messages, rush shipping → already cut in Section 13. Good. Hold the line.

# Final recommendation

- Lock the 15 decisions in the "What I would lock" section in writing before any code is generated. Hand Claude Code a plan with no "TBD" and no "empirically later." Every TBD becomes a freehand decision under deadline pressure.
- Cut to 2 themes, cover + 1 hero, single format, preview-before-charge. This is the smallest version that still delivers the magical-gift experience, and the smallest version is the version that can actually ship clean.
- Define the human queue and the customer regen flow as concrete UI/admin specs — even rough ones. These are the two surfaces most likely to get built badly without a spec.
- Make the photo intake gate and the structured input requirement non-optional. These two changes alone eliminate a large fraction of the "reputational" failure modes from earlier rounds.
- Block launch on the 20-book print test and on a real load test of both FAL endpoints. Both are cheap, both are easy to skip, both will hurt you if skipped.
- Replace every adjective threshold with a number. Kill switches, auto-fails, cost ceiling, SLA, retention. Numbers can be wrong and tuned; adjectives can't be implemented.
- Add the "what changed from v1" log to the plan. As you cut to 2 themes / cover + 1 / single format, write down what was deferred and why. Future-you will need this when the team starts asking "weren't we doing 6 themes?"
- Keep one named human as the v1 QA owner and bottleneck. Don't try to design around that bottleneck — design with it. The bottleneck is the product, per Section 1's own framing. The plan should make that role's daily workflow explicit.

# Hard truth

This plan reads like three rounds of good thinking that got smoothed into a document where the sharpest edges — the actual numbers, the actual scope cuts, the actual one-or-the-other decisions — got softened into "preferred" / "recommended" / "materially" / "empirically later" language. Consolidation has a way of turning decisions back into options, and options back into TODOs, and TODOs back into freehand choices made by whoever is closest to the keyboard at 11pm. The single most uncomfortable thing about this document is that it almost looks done, which is more dangerous than looking unfinished, because a plan that looks done will get implemented as-is, and the gaps will be filled by Claude Code or by exhausted humans rather than by you. Spend one more session turning every adjective into a number and every "preferred" into a "this is what we're doing," and then implementation can start. Don't ship the soft version of this plan; ship the hard one.
