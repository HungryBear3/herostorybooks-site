# HSB funnel and drop-off diagnostics

Read-only. Nothing here sends an event, calls GA4, reads a credential or
changes a GA4/Vercel/Meta setting. The report is **GA4 behavioral evidence
only**: it is not revenue and not payment authority. Paid orders are whatever
the signed Stripe webhook settled (`npm run order:status`, the admin board and
Stripe itself); reconcile against those, never against this report.

## What is measured, and by which existing event

No new browser event was added. Every stage reads an event the analytics
contract (`src/lib/analytics-event-contract.ts`) already governs.

| # | Stage (`stage_id`) | Source | Notes |
| --- | --- | --- | --- |
| 1 | `landing` | GA4 users + sessions, all traffic | Break down by `landing_route` (GA4 `landingPage`, re-governed to an approved route or `other`) |
| – | engagement (context) | `name_preview_submitted` | Homepage name-preview "Start book" click. Optional path, so it is reported beside the chain, not in it |
| 2 | `checkout_entry` | `checkout_step_view`, any step | A resumed draft can open past step 1, so this is not the step-1 view |
| 3 | `step_view:<step>` / `step_complete:<step>` | `checkout_step_view` / `checkout_step_complete` per `step_id` | Steps: `hero-details`, `hero-appearance`, `people`, `review`. `review` completes at a validated, lock-winning submit |
| – | friction | `checkout_step_blocked` per `step_id` and closed `reason` | 13 reasons in `CHECKOUT_STEP_BLOCKED_REASONS`; an unknown label degrades to `other` |
| 4 | `submit_attempt` | `order_submit_attempt` | Fires with `begin_checkout` and the `purchase_intent` alias at the same moment; only `order_submit_attempt` is read |
| 5 | `purchase` | server-only GA4 `purchase` | Written once by the settled webhook winner through the Measurement Protocol; the browser cannot emit it |

The basis is **users** (GA4 `totalUsers` per event), not event counts: the
review step completes again on every validated retry and a reload re-emits a
step view, so event counts over-state progress. Event counts are shown beside
users for context.

It is an **open funnel**: each stage counts users who fired that event in the
range, independently. A later stage can exceed an earlier one (a buyer who
entered checkout before the range, a draft resumed on another device). That is
reported as `NON_MONOTONIC` and never clamped.

**Known blind spot.** Between `submit_attempt` and `purchase` the funnel
cannot tell a failed submit (upload, `/api/order`, Stripe hand-off) from a
buyer who abandoned the Stripe payment page. Submit failures are recorded by
the existing first-party checkout diagnostics (`CHK-…` codes,
`src/lib/checkout-submit-diagnostics.ts`), not by GA4. No event was added at
the Stripe hand-off: the checkout form requires that nothing run between the
validated redirect URL and the navigation. Splitting this stage needs its own
ruling.

## Owner prerequisites (all `owner_action_pending`)

From `config/analytics/ga4-admin-checklist.v1.json` — nothing here is done by
this repo:

1. Register the event-scoped custom dimensions the funnel reads: `step_id`,
   `reason`, `selected_format` (the `hsb_ft_*`/`hsb_lt_*` purchase
   dimensions are for attribution, not this report). GA4 only populates a
   custom dimension from the day it is registered; earlier days report
   `(not set)`, which the report marks `DIMENSION_VALUE_NOT_SET`. Choose a date
   range that starts after registration.
2. Keep `purchase` as the only key event (once per event). `page_view`,
   `begin_checkout`, `name_preview_submitted`, the three step events and
   `order_submit_attempt` are explicitly **not** key events.
3. Turn Enhanced Measurement **Site search** and **Page changes based on
   browser history events** off on the `G-68FKEDZEG3` web stream. Site Search
   turns any `q=`-style query into `view_search_results` (HSB has no site
   search); history page changes add a second `page_view` owner beside the
   app's own, outside the GA path boundary.
4. Run the checklist readback (`docs/analytics/README.md` §2, including the
   Enhanced Measurement read with the numeric stream id) to `MATCH` before
   starting the 48-hour window.

## Running it

```bash
# 1. Build the exact read-only requests (no network).
node --experimental-strip-types scripts/funnel-diagnostics.ts plan \
  --property <numeric property id> --start 2026-10-01 --end 2026-10-28 \
  [--breakdown none|device_category|landing_route|campaign|selected_format] > plan.json

# 2. Outside this repo, POST each `requests[i].body` to its `url` with an
#    `analytics.readonly` token. Save the raw responses as one JSON object
#    keyed by request id: {"traffic": {...}, "events": {...}, "steps": {...}, "blocked": {...}}
#    (`selected_format` plans have only "steps" and "blocked").

# 3. Build the report (no network).
node --experimental-strip-types scripts/funnel-diagnostics.ts report \
  --plan plan.json --responses responses.json --format text   # or json
```

The report is bound to the exact plan: an edited plan (another dimension,
limit or property) is `REQUEST_PLAN_INVALID`; a response set that does not
answer exactly the plan's requests is `RESPONSES_SHAPE`; a malformed response
(unknown fields, wrong headers, a row outside the request's event filter, a
repeated row, users above events, a non-integer count, a conflicting
timezone) is refused with value-free `CODE@$.path` lines and exit 3. The
zero-dimension `traffic` request of the default breakdown is read in the
proto3 JSON shape the Data API emits (no `dimensionHeaders`, rows with only
`metricValues`); every request that asks for dimensions must still return its
headers and row values. The GA4 Data API compatibility of each request has not
been exercised against a live property, so the first live run of each
breakdown is also its compatibility check; an API error body is not a
`runReport` and is refused.

## Reading the report

- `evidence: COMPLETE` means every stage GA4 answered is complete. Otherwise
  `INSUFFICIENT_EVIDENCE` names why: `SAMPLED`, `THRESHOLDED` (GA4 withheld
  small rows, typically from Google signals), `OTHER_ROW` (rows folded into
  `(other)`), `TRUNCATED` (more rows than returned), `EMPTY_REASON` (GA4
  explained an empty report), `DIMENSION_VALUE_NOT_SET`, or
  `OUT_OF_CONTRACT_VALUE` (a value the contract never sends: investigate the
  instrumentation, not the buyer). An insufficient stage has **null** counts.
- `rate_from_first` is the share of the first stage (landing, or the step-1
  view for `selected_format`). `rate_from_previous`, `drop_off_users` and
  `drop_off_rate` compare a stage to the one before it.
- `rate_status`: `OK`; `FIRST_STAGE`; `NOT_COMPUTED` (a neighbouring stage is
  insufficient); `NO_DENOMINATOR` (previous stage is zero);
  `DENOMINATOR_BELOW_MINIMUM` (fewer than 30 users before it — the drop-off
  count is shown, the rate is withheld); `NON_MONOTONIC`.
- `merged_raw_values: true` means several raw GA4 values (e.g. unapproved
  landing pages) were collapsed into one label and summed, so its user counts
  are an upper bound.
- `purchase` always carries `BEHAVIORAL_NOT_PAYMENT_AUTHORITY`. Under a
  breakdown it also carries `SERVER_EVENT_SEGMENT_PARTIAL`: a server-written
  purchase inherits a session's device, landing page and campaign only when
  the webhook had the buyer's GA session id; the rest land in `not_set`. Use
  the `hsb_lt_*`/`hsb_ft_*` purchase dimensions for purchase attribution.
- `selected_format` is recorded when each step event fires; before the buyer
  picks a format it is `not_set`, so this breakdown is meaningful mainly at
  the review step.

Values are never echoed from GA4: segments are an approved route, a governed
campaign, `desktop|mobile|tablet`, a book format, or `none`/`not_set`/`other`.

## Choosing friction experiments

The report locates **where** users stop; it does not say **why**, and it
cannot show that a change **caused** an improvement. Use it to pick one
hypothesis at a time:

1. Look for the stage with the largest `drop_off_users` where `rate_status`
   is `OK`. Ignore stages with insufficient evidence or small denominators.
2. For a checkout step, read that step's `friction` entry: `blocked_rate`
   and its top `reason` point at the validation rule people hit. A high
   `hero_name_required` or `hero_appearance_required` rate is a copy/layout
   question for that field; a high drop-off with a low blocked rate means
   people leave without trying to continue.
3. Break down by `device_category` before blaming a step: a gap that exists
   only on `mobile` is a mobile-layout hypothesis. Break down by
   `landing_route` or `campaign` to see whether the drop is traffic-quality
   rather than checkout friction.
4. Write the hypothesis and the one metric it should move (for example
   "`step_complete:hero-appearance` / `step_view:hero-appearance` on mobile")
   into the experiment registry (`config/analytics/experiment-registry.v1.json`,
   README §5) with its `evidence_threshold` before changing anything.
5. Compare equal-length windows before and after, with the same breakdown,
   both `COMPLETE`. Differences are observational: seasonality, campaign mix
   and GA4 processing all move these numbers. Treat a change as a signal to
   keep or revert, confirmed against Stripe-settled orders, not as proof.
