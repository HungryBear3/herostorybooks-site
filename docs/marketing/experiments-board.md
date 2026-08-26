# HSB 30-day experiment operating board

**Human view. Not authoritative.**
`experiments-board.json` in this directory is the authoritative copy;
`src/lib/marketing/experiments-board.ts` validates it and
`tests/marketing-experiments-board.test.ts` runs that validator against the real file
on every `npm test`. If this page and the JSON disagree, this page is wrong.

**Date:** 2026-08-26 · **Owner:** Alexy · **Schema:** 1.0.0

---

## Status right now

**Every row is `proposed`. No approval of any kind is granted. Nothing has been
posted, connected, or spent.** No row reports an actual result, and the validator
refuses to let one claim a measured number without a value.

| ID | Channel | Medium | Status | Cap | Window | Primary conversion |
|---|---|---|---|---|---|---|
| `HSB-2026-09-01-SCHOOL-PILOT` | School / after-school partnership | `partner` | proposed | $0 | 2026-09-01 → 09-30 | trusted paid purchase |
| `HSB-2026-09-02-PARENT-GROUP` | Parent group referral | `referral` | proposed | $0 | 2026-09-01 → 09-30 | trusted paid purchase |
| `HSB-2026-09-03-COMMUNITY-QR` | Community venue, printed QR | `flyer` | proposed | $0 | 2026-09-01 → 09-30 | trusted paid purchase |
| `HSB-2026-09-04-ORGANIC-SIDECAR` | Organic social | `organic_social` | proposed | $0 | 2026-09-01 → 09-30 | trusted paid purchase |
| `HSB-2026-09-05-META-CAPPED-TEST` | Meta paid social | `paid_social` | proposed | $150 | 2026-09-15 → 09-30 | trusted paid purchase |
| `HSB-2026-10-01-REDDIT-GEO-TIGHT` | Reddit paid social | `paid_social` | proposed | $100 | 2026-10-01 → 10-31 | trusted paid purchase |

## Pilot priority

1. **School, parent-group, and community partnerships are the primary funnel.** Three
   of the six rows, all unpaid, all starting first. Broad paid advertising is not the
   default here.
2. **Automated organic social is a measured low-effort sidecar**, not a channel. Its
   kill rule is unusual on purpose: it dies if it stops being low-effort, even if the
   numbers are fine.
3. **The Meta conversion test stays `proposed`** until measurement is proven, capacity
   is stated, and contribution per order is re-derived at live prices. All three, not
   any one.
4. **Reddit is future and geo-tight**, sequenced strictly after the Meta row reaches a
   decision.

## Rules the validator enforces

`npm test` fails the board if any of these is violated:

- duplicate `experiment_id`;
- a date that is not a real ISO date, or an `end_date` before its `start_date`;
- a status outside `proposed · approved · live · paused · completed · invalid`;
- a negative spend cap;
- a UTM value that is malformed, over 40 characters, outside the medium vocabulary,
  or PII-like (mailbox provider, `-at-` mangling, 7+ digits, 16+ hex, a Stripe/HSB id
  prefix, a token word);
- two rows sharing a governed UTM tuple;
- a `live` / `paused` / `completed` row without a granted `public_posting` approval;
- a `paid_social` row with no positive cap, or one at a public status without
  granted `paid_spend` **and** `account_connection` approvals;
- a granted approval with no approver, no valid date, or no evidence reference;
- a missing or duplicated 24h / 48h / 7d / 30d checkpoint;
- an empty `decision` or `next_action`;
- **an invented result** — `quality: measured` with no value, or a value whose note
  does not mark it as an estimate or unverified.

## Three approvals, three decisions

They are separate fields because they are separate calls, potentially by different
people:

| Approval | Gates |
|---|---|
| `public_posting` | anything becoming publicly visible — a post, a card, a poster, a partner email |
| `account_connection` | connecting an ad account, a dataset, a pixel, or a scheduling tool |
| `paid_spend` | money leaving, and the cap it may not exceed |

A granted approval must carry an approver, an ISO date, and an evidence reference.
"Granted" with nobody's name on it is rejected.

## Checkpoints

Every row carries exactly four: **24h, 48h, 7d, 30d**, each with a due date and an
evidence quality. Early checkpoints exist to catch "nothing is arriving at all"
before a month has passed, not to declare a winner.

## Keep / kill / iterate — what counts

**Counts:** qualified visits · checkout starts (`begin_checkout`) · trusted paid
purchases from the signed Stripe webhook · paid-order bottlenecks against attended
fulfillment capacity · revenue · contribution after COGS.

**Does not count:** impressions · reach · followers · likes · shares · click-through
rate on its own · Meta- or Reddit-reported conversions used as the number of record
rather than as a cross-check.

**One major variable per row.** The three partnership rows differ in exactly one
thing — institutional introduction, peer forwarding, or unattended physical placement
— while price, product, and landing page stay fixed.

## Unit economics — the standing blocker

`docs/unit-economics-baseline-2026-05-13.md` models **$14.99 / $39.99 / $59.99**.
Those are **not the live prices**; `src/lib/orders.ts` charges **$19 / $39 / $64**.
Its AI-cost and premium-print inputs are also self-labelled placeholders.

So HSB has **no measured contribution per order at current prices**, and therefore no
allowable CAC. Both paid rows carry a `null` target with `quality: unverified` rather
than a made-up number, and neither can be approved on a click-through rate.

Re-deriving contribution at live prices is a prerequisite for approving either paid
row, and it is not part of this candidate.

## How to use this board

1. Edit `experiments-board.json` — never this page first.
2. Run `npm test`. The validator will reject anything above.
3. Regenerate this page by hand to match, then commit both together.
4. To move a row to `live`: record the `public_posting` approval **in the JSON**
   with an approver, a date, and an evidence reference. The validator refuses a
   public status without it, which is the point.
