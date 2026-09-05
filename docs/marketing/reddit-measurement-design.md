# Reddit measurement — design only, nothing activated

**Status:** future. **Date:** 2026-08-26.

Nothing in this document is implemented. There is no Reddit pixel, no Reddit
Conversions API code, no Reddit token, no Reddit environment variable, and no Reddit
ad account referenced anywhere in this repository. This is what the work *would* look
like, written down now so the Meta candidate's shape is not reinvented later under
time pressure.

**Sequencing rule:** Reddit does not start until the Meta row
(`HSB-2026-09-05-META-CAPPED-TEST`) has reached a decision. Two unproven paid
channels running at once cannot be told apart, and HSB's fulfillment is attended.

---

## 1. Event mapping

The canonical stages are unchanged; only the vendor names differ.

| Canonical stage | GA4 (live) | Meta (candidate) | Reddit (design) | Owner |
|---|---|---|---|---|
| `page_view` | `page_view` | `PageView` | `PageVisit` | browser |
| `view_product` | — | — | `ViewContent` | deferred — no surface proves it |
| `begin_checkout` | `begin_checkout` | `InitiateCheckout` | `AddToCart` | browser |
| `purchase` | `purchase` | `Purchase` (server) | `Purchase` (server) | Stripe webhook |

Reddit's standard vocabulary has no exact `InitiateCheckout`; `AddToCart` is the
closest funnel-position equivalent and would be documented as such rather than
presented as a literal match. `Purchase` is server-only for the same reason it is on
Meta: Stripe is authoritative and no browser surface may compete.

## 2. Deduplication

Reddit's CAPI deduplicates on `conversion_id`. The same derivation as Meta applies:
a SHA-256 pseudonym of the Stripe Checkout Session id, salted with a Reddit-specific
prefix so the two platforms never receive the same value.

```
conversion_id = "hsb_" + sha256("hsb:reddit:purchase:" + <stripe session id>)[0..32]
```

Stable across webhook replays, not reversible to an order, and distinct from the Meta
`event_id`. The same "a failed send does not burn the id" rule applies.

## 3. Consent

Identical gate to Meta: `resolveConsent()` must return `granted`. Absent or unknown
fails closed. A real shared consent surface now exists (see
`attribution-event-contract.md` §0.1), so this gate is live rather than
theoretical — a Reddit pixel would be governed by the same single source of
truth as GA4, Vercel Analytics, and Meta, and would load nothing before a
grant.

## 4. CSP

There is still no site-wide CSP to extend, and Reddit must not appear on the
family-review CSP. If a site-wide CSP is introduced, the **exact** origins would be:

```
script-src   https://www.redditstatic.com
img-src      https://alb.reddit.com
connect-src  https://conversions-api.reddit.com
```

No wildcards. As with Meta, script loading would be gated on the public route
allowlist, so nothing would be requested on any private surface.

## 5. Blocked data

The same list as the Meta contract, without exception: no `user_data`, no email or
phone hashes, no `external_id`, no IP or User-Agent forwarding, no order or session
identifier, no child or family data, no asset URL, no free text. Reddit's matching
guidance recommends hashed identifiers; HSB would decline them for the same reason it
declines Meta Advanced Matching, and would accept the weaker attribution.

## 6. Experiment requirements

Codified as `HSB-2026-10-01-REDDIT-GEO-TIGHT` in `experiments-board.json`:

- **Geo-tight to one metro.** A national test is a different, unapproved row.
- **Hard spend cap**, currently $100, enforced by the board validator, which refuses
  a `paid_social` row with no positive cap.
- **Three separate approvals** before anything happens: `public_posting`,
  `account_connection`, `paid_spend`.
- **Sequenced after Meta.**
- **Subreddit rules first.** Reddit communities have their own self-promotion rules.
  Paid placement does not exempt anyone from reading them, and organic participation
  in a parenting subreddit without doing so is how a brand gets banned.
- **Capacity before budget.** The cap is set by attended fulfillment capacity first.

## 7. Environment variable names, if it is ever built

| Name | Scope |
|---|---|
| `NEXT_PUBLIC_REDDIT_PIXEL_ID` | browser, public |
| `NEXT_PUBLIC_REDDIT_PIXEL_ENABLED` | browser, public |
| `REDDIT_CAPI_ACCESS_TOKEN` | server only |
| `REDDIT_CAPI_ENABLED` | server only |

Listed for symmetry with Meta. **None of these is read by any code in this
repository**, and adding one is a new change with its own review.
