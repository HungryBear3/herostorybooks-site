# HSB Customer-Safe Delay / Hold Message Templates

**Status:** Operator wording reference. Not auto-sent. Used by the QA Production Room and support when a paid customer's proof is held by the Generation Operating Policy guard.

**Rule:** customer-facing copy MUST NOT expose provider names (OpenAI, fal, Seedream, Gemini), model names, fallback flags, internal error codes, QA checklist items, manifest hash, or "template fallback" language. Lead with the customer's name; reassure that nothing has shipped without their approval; offer a path forward.

---

## 1. Generic hold — "Your book is in review"

**Subject:** Your storybook is in review

> Hi [first name],
>
> Your book for [child name] is in our final review now. Our team checks every proof by hand before we share it, so it's just held back for a quick once-over.
>
> We'll email you the proof to review as soon as it clears. If you have any questions in the meantime, reply to this note and a real person will get back to you.
>
> — The HeroStoryBooks team

## 2. Manual rework — "We're polishing one detail"

**Subject:** A small polish on [child name]'s storybook

> Hi [first name],
>
> Quick update — we noticed something on [child name]'s proof we'd like to polish before sending it to you. We're working on it now.
>
> You haven't been charged anything extra; we'll send the updated proof as soon as it's ready (usually within 24 hours). If you'd prefer to wait for our message rather than checking the order page, that works too.
>
> Thanks for your patience.
>
> — The HeroStoryBooks team

## 3. Time-sensitive delay (Father's Day window)

**Subject:** A heads-up on [child name]'s gift

> Hi [first name],
>
> We're holding [child name]'s proof for a final hand-review. With Father's Day close, we wanted to flag the timing so you can plan.
>
> If anything would prevent us delivering before [gift date], we'll email you ahead of time with a refund offer and a digital placeholder you can print at home. We'll only continue with the printed book if you confirm you still want it.
>
> — The HeroStoryBooks team

## 4. Refund offer — "We can't deliver in time"

**Subject:** Your HeroStoryBooks order — refund offer

> Hi [first name],
>
> We don't want to over-promise on timing for [child name]'s book. Rather than risk it arriving late, we'd like to offer a full refund and a complimentary digital placeholder PDF you can print at home now.
>
> Reply YES to refund and we'll process it the same day. Reply WAIT and we'll keep working — we'll keep you updated on progress every 24 hours.
>
> — The HeroStoryBooks team

## 5. Print held — "We need one more piece of info"

**Subject:** Quick info on [child name]'s printed book

> Hi [first name],
>
> Your proof is approved and ready to print. Before we send it to the press we just need to double-check the shipping address on file. Could you confirm: [redacted summary]?
>
> Reply YES to confirm, or send a corrected address. The book stays in our queue and nothing ships until we hear back.
>
> — The HeroStoryBooks team

---

## Internal mapping — release guard failure code → recommended customer template

| Release guard failure code (`evaluateReleaseGuard`) | Customer template |
|---|---|
| `TEMPLATE_STORY_BLOCKED` | Template 2 (manual rework) — operator rewrites prose before re-running QA |
| `FIXTURE_ASSET_BLOCKED` | Template 2 (manual rework) — operator regenerates affected page |
| `MISSING_LINEAGE` | Template 1 (generic hold) — operator investigates page provenance |
| `EMERGENCY_APPROVAL_MISSING` | Template 1 (generic hold) — operator records emergency approval OR regenerates |
| `PROVIDER_ROUTE_BLOCKED` | Template 1 (generic hold) — same as above |
| `MANIFEST_INCOMPLETE` | Template 1 (generic hold) |
| `QA_NOT_PASSED` | Template 1 (generic hold) — operator completes 12-item checklist |
| `PAYMENT_NOT_CONFIRMED` | Stripe-side issue; outside the customer-delay template surface |
| `NO_ARTIFACT` | Template 2 (manual rework) — artifact rebuild required |

## Print guard failure → recommended customer template

| Print guard failure code (`evaluatePrintGuard`) | Customer template |
|---|---|
| `CUSTOMER_APPROVAL_REQUIRED` | (No customer message needed — customer hasn't acted yet) |
| `PRINT_QA_GUARD_FAILED` | Template 2 (manual rework) |
| `PRINT_MANIFEST_INVALID` | Template 2 (manual rework) |
| `PRINT_LINEAGE_INVALID` | Template 2 (manual rework) |
| `PRINT_STATE_INVALID` | Template 1 (generic hold) — operator inspects state machine |
| `PRINT_PAYMENT_INVALID` | Stripe-side issue; outside the customer-delay template surface |

---

**Source gap:** the original Generation Operating Policy artifact's "Section 10 customer messages" was not available in-repo at policy implementation time. These templates are conservative starting copy distilled from the policy's customer-safe wording rules (no provider/model/internal exposure). Replace verbatim with Alexy/Rex's canonical wording when the original surfaces.
