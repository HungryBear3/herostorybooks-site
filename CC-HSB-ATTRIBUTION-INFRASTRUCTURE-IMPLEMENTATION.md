# CC — HSB decision-grade attribution infrastructure (implementation)

**Date:** 2026-10-02
**Worktree:** `/Users/abigailclaw/cc-worktrees/hsb-attribution-implementation-20261002`
**Branch:** `rex/hsb-attribution-implementation-20261002`
**Base HEAD:** `28e8e2f7c209369f3ed68f1ceb57bc703f56c85f` (unchanged; nothing is committed)
**Audit implemented:** `../hsb-analytics-resume-20261002/CC-HSB-CAMPAIGN-ATTRIBUTION-READINESS.md`, slices S1, S2 and S3
**Status:** `IMPLEMENTED_LOCAL_UNCOMMITTED — CONTROLLER_VERIFIED_AFTER_FINAL_REVIEW_FIX`

No commit, push, PR, merge or deploy. No live DB, store, provider, network, GA4, Stripe or Vercel access. No env, dashboard or config activation. I added no registry experiment, campaign slug, budget or dates: `config/analytics/experiment-registry.v1.json` is unchanged and still has `experiments: []`. I changed no privacy or legal copy and did not touch confirmation-email or fulfillment code. All test data is synthetic.

---

## Final narrow fix cycle (current evidence; supersedes all evidence below)

Only the two remaining blockers were changed in this cycle. No commit, push, deploy, live-service access or unrelated source/doc change.

- Every plain order record must carry the exact canonical durable identity `ord_[a-f0-9]{16}` used by checkout/orders. Length is checked as well as the regex (including rejection of trailing newlines); no trimming, coercion or case normalization. Missing, null, whitespace, numeric and otherwise malformed identities become undated `order_identity_invalid` before classification or coverage scoping. Non-record inputs retain `record_invalid`. Every duplicate/conflicting canonical identity remains an undated rejection of every copy. Identity values never enter output.
- The closed ledger validator now enforces the builder's existing maximum of **366 inclusive coverage days** and refuses oversized coverage with `RANGE_TOO_LONG@$.coverage` before row/report computation.
- All decision-report ledger sums (including every cent field) accumulate as BigInt and are converted only after checking `Number.MAX_SAFE_INTEGER`; overflow returns the value-free typed refusal `INTEGER_OUT_OF_RANGE@$.ledger.<field>`. With the current coverage, per-row and uniqueness bounds, a valid single-segment report cannot reach this overflow branch; the checked conversion also protects future bound changes.
- Synthetic positive-order fixtures now use canonical identities. Regressions cover single and paired malformed identities, every exclusion class, dates before/inside/after coverage, duplicate conflicts, input-order determinism, privacy, and decision-threshold inflation.
- The 10,000-day adversary was reproduced RED: exact **9,999,000,000,000,001 cents** produced `COMPUTED` with **9,999,000,000,000,000** before remediation. It now refuses at coverage validation. Exact totals at `MAX_SAFE_INTEGER - 1`, `MAX_SAFE_INTEGER`, `MAX_SAFE_INTEGER + 1`, and `MAX_SAFE_INTEGER + 2` also refuse unsupported coverage. A 366-day maximum-row-cents control remains `COMPUTED` with exact safe cent totals and identical output after row reversal.

Files changed in this cycle: `src/lib/attribution-ledger-export.ts`, `src/lib/attribution-decision-report.ts`, `tests/attribution-ledger-export.test.ts`, `tests/attribution-decision-report.test.ts`, and this report. Generated graph outputs are git-ignored.

Real verification:
- RED before production edits: **45 tests, 40 pass, 5 expected assertion failures** (malformed identity classification/decision boundary, validator coverage bound, 10,000-day arithmetic adversary, safe-integer boundary coverage). Log: `/Users/abigailclaw/.hermes/cache/scratch/attribution-cycle2-red.log`.
- Four focused suites (`attribution-ledger-export`, `attribution-decision-report`, `campaign-registry-link`, `campaign-governance`): **63 pass, 0 fail, 0 skipped**.
- Full relevant set: the same **129** analytics/attribution/campaign/decision/GA4/Meta/payment/Stripe/webhook/refund/order/checkout/print-upgrade/settlement test files, under `sandbox-exec` denying outbound IP network: **1891 tests, 1890 pass, 0 fail, 1 existing build-dependent skip**. Log: `/Users/abigailclaw/.hermes/cache/scratch/attribution-cycle2-broad.log`.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `git diff --check`: exit 0.
- `graphify update .`: exit 0, AST-only, 706 files, 4258 nodes, 9305 edges, 181 communities.
- Final independent review found no remaining runtime logic/security blocker, but correctly failed the candidate because three new synthetic malformed-ID literals matched the repository's production-shaped order-ID committability guard.
- Controller-only hygiene correction split those synthetic literals at source construction without changing their runtime values. The exact REQ16 guard then passed **1/1**; the four focused suites passed **63/63**; `npx tsc --noEmit -p tsconfig.json` passed; and the complete direct Node test inventory passed **4197**, failed **0**, skipped **1** across **4198** tests. `git diff --check` and the final `graphify update .` passed. No third independent-review cycle was used.

Full repository `npm test`, production build and lint are not claimed. All earlier inventories, hashes, counts and status summaries below are historical, not the final candidate fingerprint.

## First independent-review blocker fixes (historical evidence)

The original implementation inventory/hashes and verification counts below are historical, not the current candidate fingerprint. This narrow follow-up fixes only the five review blockers:

- Tracking tags must be canonical strings; null tag values (including a null sibling beside a valid tag) are `checkout_tracking_invalid`, never exclusions. A null tracking object still means no tags.
- Settled records without a valid `paidAt` are undated integrity rejections before coverage scoping. They cannot inherit `createdAt` or disappear outside coverage/window.
- The closed validator reconciles every count/cents field across models for each paid day, summed across segments. Exact BigInt accumulation prevents floating-point loss; day equality also reconciles every decision subwindow.
- Repeated durable `id` strings are detected over the entire input before scoping. Every copy, including conflicting/out-of-coverage copies, becomes undated `order_identity_duplicate`; none contributes metrics. Identifiers never leave the in-memory comparison.
- Documented invocations include `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`. This suppresses only Node's known typeless-module warning (which otherwise prints absolute paths), not errors or other warning classes, and changes no package/module semantics. Use the complete documented invocation; bare Node invocations can still emit that runtime warning. Node v24.18.0 rejects `--experimental-default-type=module`, so that option was not adopted.

Direct regressions exercise malformed tags, missing/invalid paid days before/inside/after coverage, all monetary/refund/upgrade allocations, day swaps preserving grand totals, identical/conflicting identities, duplicate snapshot files, decision threshold and revenue refusal, and CLI stderr on success/refusal/usage/unreadable input. CLI children run with a minimal environment without inherited `NODE_OPTIONS`.

Verification of this follow-up:
- RED: original implementation failed all four new ledger behavior regressions and all three CLI stderr assertions (7 failures); three added decision-boundary regressions also failed before the fixes.
- Focused: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test --test-concurrency=1 tests/attribution-ledger-export.test.ts tests/attribution-decision-report.test.ts tests/campaign-registry-link.test.ts tests/campaign-governance.test.ts` — **57 pass, 0 fail, 0 skipped**.
- Broad: the same 129 analytics/attribution/campaign/decision/GA4/Meta/payment/Stripe/webhook/refund/order/checkout/print-upgrade/settlement test files as the original run, under `sandbox-exec` denying outbound IP network — **1885 tests: 1884 pass, 0 fail, 1 skipped** (existing production-bundle check requires a build).
- `npx tsc --noEmit -p tsconfig.json` — exit 0.
- `git diff --check` — exit 0.
- `graphify update .` — exit 0; AST-only, 706 files, 4256 nodes, 9297 edges, 181 communities; ignored output in `graphify-out/`.

No live-service access, commit, push or deployment. Full suite/build/lint are not claimed.

---

## 1. Files

| Path | State | Lines | SHA-256 |
| --- | --- | --- | --- |
| `src/lib/attribution-ledger-export.ts` | new (S1) | 599 | `fec11dcfdd650b58cca92c43c7270c80a92c119f95b712a873d2070428b489a7` |
| `src/lib/attribution-decision-report.ts` | new (S2) | 248 | `1134ce4405cf1c2121567e4ebc8813df3f4f6094cd1dae96ca89e9f0563acc6d` |
| `scripts/attribution-decision.ts` | new (S1 + S2 CLI) | 159 | `8229f2bf15d236f57b14c6d38ea9249f13ea583757618200a5fd3c9660f37c19` |
| `src/lib/campaign-governance.ts` | modified (S3 + one export) | +37 / −1 | `82b13b4ef00a92b7ebe73dcd44cf836682d9b6d72dd9f803db17ae48f2feef33` |
| `scripts/analytics-governance.ts` | modified (S3 `link` command) | +28 / −2 | `9b87173478ef98a1a9109508d9646f7d8143bd6dc5abfe10c5da5dd63e4a29ee` |
| `tests/attribution-ledger-export.test.ts` | new | 567 | `e65701377df8af6bcf26800282f9cc5640cc517143e9d92d32f6cf3fd14b7dd5` |
| `tests/attribution-decision-report.test.ts` | new | 397 | `644089e7afd74974fa634ca1805789a4f77421ec1079db935da453637ca04347` |
| `tests/campaign-registry-link.test.ts` | new | 171 | `a05c96e5367f1b409e197a6ac176daab49102b59dedce816a6a07cc99c64c3f4` |
| `CC-HSB-ATTRIBUTION-INFRASTRUCTURE-IMPLEMENTATION.md` | new (this report) | — | — |

`git diff --stat` (tracked files only): 2 files, 65 insertions, 3 deletions. No path under `config/`, `docs/` or `src/app/` changed. No app route, middleware or browser bundle imports any changed module.

**Local-only, not deliverables:**
- `node_modules` is a symlink to `../hsb-a36-reconciliation-20261001/node_modules`, whose `package-lock.json` hash `ad36b2ff…` matches this worktree's. It is git-ignored.
- `graphify-out/` was created by `graphify update .`. It is git-ignored (`.gitignore:27`).

---

## 2. What was built

### S1 — Read-only ledger attribution export (`hsb.decision_export.ledger` v1)

`buildLedgerAttributionExport({ orders, registry, timezone, coverage, generatedAt, dataOrigin })` is a pure function apart from SHA-256 hashing. Its CLI is:

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/attribution-decision.ts ledger-export --orders-dir D --start D --end D --timezone TZ [--registry F] [--data-origin O] [--generated-at TS]
```

**Data-source boundary.** The CLI reads a read-only snapshot directory with one `*.json` order record per file. Other file names and subdirectories are ignored. An unparsable file becomes an integrity rejection; it is never skipped. Producing the snapshot from the store is a separate, separately authorized operator step. I built no store adapter, and nothing here calls `listOrders` (which silently skips corrupt blobs).

**Grouping.** Rows are grouped by day × model × segment class.
- **Day** is `paidAt` in the export timezone (`EXPORT_TIMEZONES`, shared with the GA4 export). Unpaid orders use the `createdAt` day.
- **Models:**
  - `last_non_direct_touch` is primary. It uses `checkoutAttribution.lastNonDirectTouch`, falling back to `firstTouch` exactly as `currentBrowserCampaignParams` does for GA4.
  - `first_touch` is secondary.
  - Both models allocate the same counted orders, and the validator enforces this.
- **Segment classes:**
  - `registered:<experiment_id>`: source, medium, campaign, content (null-exact) and landing path equal one validated registry entry, and the touch's capture day in the export timezone falls inside that entry's inclusive window. Any status counts, because the registry already forbids overlapping windows, including cancelled ones.
  - `unregistered_governed`: a complete governed tuple with no such match.
  - `partial`: a source without a medium or a campaign.
  - `direct`: no touch, a direct touch, or no `checkoutAttribution`.
  - Two matching windows produce `registry_match_ambiguous` (an integrity rejection) and are never assigned. A validated registry cannot produce this.
- **Attribution re-validation.** The stored `checkoutAttribution` is checked through `parseAttributionState`, relative to the order's own `createdAt`, with the checkout's 35-day accept window. Any non-canonical, extra-key, `utm_term`, future or too-old state becomes `attribution_invalid`. It is never treated as direct.

**Every record lands in exactly one place.** The totals invariant `records_read = outside_coverage + excluded + integrity_rejected + counted` is enforced by the validator.
- **Exclusions** are closed and applied in precedence order:
  1. `internal_disposition`: either enum value.
  2. `cohort_or_invite`: a canonical `checkoutTracking` tag.
  3. `unpaid`: `pending` or `failed`.
  4. `zero_or_no_payment_required`: `settledAmountCents === 0`.
- **Integrity rejections** are closed:
  - `record_invalid`, `timestamp_invalid`
  - `internal_disposition_invalid`, `checkout_tracking_invalid`
  - `payment_status_invalid`, `payment_facts_invalid`: a settled status without an exact `paidAt` or an integer `settledAmountCents`
  - `refund_in_flight`: `refundClaimId` is set
  - `refund_facts_invalid`: for example `paid` with a refund marker, `partially_refunded` without an amount strictly between 0 and settled, or a full refund recorded above settled
  - `print_upgrade_facts_invalid`
  - `attribution_invalid`, `registry_match_ambiguous`
- A record with no trustworthy day becomes an undated integrity rejection, and it stays in scope.

**Money columns** per row:
- `paid_orders` and `settled_cents` (gross, from the authoritative `settledAmountCents`)
- `fully_refunded_orders` and `partially_refunded_orders`
- `refunded_cents`: full refund or dispute = settled; partial = `stripeRefundedAmountCents`
- `net_paid_orders` = paid − fully refunded
- `net_settled_cents`
- `print_upgrade_orders` and `print_upgrade_cents`: only `printUpgradeStatus === 'paid'` with an integer amount and an exact `printUpgradePaidAt`. This is reported separately and never added to settled revenue.

**Identity.** The export records `registry_sha256`, a SHA-256 of the registry's key-order-independent JSON.

**Privacy.** The output contains only fixed vocabulary, dates, counts, cents, the experiment id and the fingerprint. Tests assert it contains no email, name, address, `ord_`/`cs_`/`pi_`/`re_` id, raw source/medium/campaign/content/landing value, cohort/invite tag, note or reason text. CLI refusals are `REJECTED ledger_export CODE@$.path` only.

**Header refusals:** `REGISTRY_INVALID`, `TIMEZONE_UNSUPPORTED`, invalid `data_origin`, `RANGE_INVALID`, `RANGE_TOO_LONG` (≥ 366 days), `INVALID_TIMESTAMP`, and `COVERAGE_AFTER_GENERATED_AT`. The last means `generated_at` must fall on a day after `coverage.end` *in the export timezone*.

**Validator.** `validateLedgerAttributionExport` is a closed-schema validator with value-free codes. It checks:
- exact keys, enums and the segment grammar
- counts and cents as integers in range
- row invariants
- per-model totals equality
- duplicate rows
- rows inside coverage
- the closed reason vocabularies
- the totals

The builder revalidates its own output.

### S2 — Decision report join (`hsb.decision_report.attribution` v1)

`buildAttributionDecisionReport({ ledger, ga4, registry, experimentId })` is pure. Its CLI is:

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/attribution-decision.ts decision-report --ledger F --ga4 F --experiment ID [--registry F]
```

**Experiment checks.** The registry must validate. The id must match the id format exactly and identify exactly one entry. Status must be `running`, `paused` or `completed`; `planned` and `cancelled` produce `EXPERIMENT_NOT_EVALUABLE`. Only the declared primary outcome is computed:
- `paid_order_rate`: `ledger.net_paid_orders / ga4.sessions`
- `net_revenue_per_session`: `ledger.net_settled_cents / ga4.sessions`
- `checkout_start_rate`: `ga4.checkout_starts / ga4.sessions`
- `qualified_action_rate` and `paid_per_qualified_rate` produce `OUTCOME_SOURCE_UNAVAILABLE`, because `app.qualified_actions` has no producer.

**Gates.** The outcome is computed only when `denominator ≥ min_denominator` **and** `events ≥ min_events` (both inclusive). Otherwise the report has `status: INSUFFICIENT_EVIDENCE` and `outcome: null`. Counts and gate values are still reported. `outcome_evidence.unit` names the value's unit; revenue is `usd_cents_per_session`.

**Sums.**
- Ledger: rows for `registered:<id>` under the primary model, with paid day inside the window.
- GA4: rows whose source, medium, campaign and content (null → `not_set`) equal the experiment's, on **all** landing paths, with date inside the window.
- Exclusion counts inside the window are reported for all segments, because exclusions carry no segment.

**Fixed authority and model fields:**
- `ledger.authority: PAYMENT_AUTHORITY`
- `ga4.purchase_events_authority: BEHAVIORAL_NOT_PAYMENT_AUTHORITY`. The GA4 purchase count never enters an outcome; tests inflate it to equal sessions and the outcome does not move.
- `attribution_model: LAST_UTM_TOUCH_30D`
- `declarations`, a fixed list:
  - `ATTRIBUTION_MODEL_LAST_UTM_TOUCH_30D`
  - `GA4_DENOMINATOR_UNDERCOUNTS_BLOCKED_SESSIONS`
  - `GA4_DENOMINATOR_ALL_LANDING_PATHS`
  - `GA4_PURCHASE_BEHAVIORAL_NOT_PAYMENT_AUTHORITY`
  - `LEDGER_PAID_DAY_WITHIN_WINDOW`
  - `NET_PAID_ORDERS_EXCLUDE_FULL_REFUNDS`
  - `PRINT_UPGRADE_REVENUE_NOT_IN_OUTCOME`
  - `UNMARKED_INTERNAL_ORDERS_COUNTED`

**Fail-closed refusals** (value-free `CODE@$.path`):
- ledger or GA4 schema issues, re-pathed under `$.ledger` / `$.ga4`
- `REGISTRY_IDENTITY_MISMATCH`: the ledger was classified against another registry version
- `DATA_ORIGIN_MISMATCH`: the GA4 export or the registry differs from the ledger
- `TIMEZONE_MISMATCH`
- `WINDOW_NOT_COVERED`: ledger or GA4 coverage
- `GA4_WINDOW_NOT_ATTESTED`: any window day outside the attested ranges, including the sampled/thresholded case where attestation is empty
- `LEDGER_INTEGRITY_INCOMPLETE`: any integrity rejection dated in the window, or any undated one
- `DENOMINATOR_AMBIGUOUS`: another experiment shares the four-field tuple on a different landing path in an overlapping window
- `EXPERIMENT_UNKNOWN`, `EXPERIMENT_ID_FORMAT`, `EXPERIMENT_NOT_EVALUABLE`, `OUTCOME_SOURCE_UNAVAILABLE`

The CLI also refuses an unparsable input with `JSON_INVALID@$.<input>`.

### S3 — Registry-bound link CLI

`resolveRegistryCampaignLink(registry, experimentId)` is in `campaign-governance.ts`. The CLI is:

```
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/analytics-governance.ts link EXPERIMENT_ID [--registry F]
```

Behaviour:
- The whole registry must validate. One invalid sibling, a duplicate id or an overlap refuses every link.
- The id must match the id format exactly (no normalization) and identify exactly one entry.
- Status must be `planned` or `running`. `paused`, `completed` and `cancelled` produce `EXPERIMENT_NOT_LINKABLE`.
- The URL comes from the existing, unchanged `buildGovernedCampaignUrl`. It accepts only approved public route templates and round-trips exactly through the Phase-A capture. An unsafe landing path yields no link.
- Output is one canonical URL on stdout (exit 0), or `REJECTED campaign_link CODE@$.path` (exit 3). Usage errors exit 2.
- The empty checked-in registry still passes `check` (`OK experiment_registry experiments=0`). `link hsb_exp_2026_001` against it gives `REJECTED campaign_link EXPERIMENT_UNKNOWN@$.experiment_id` with exit 3. Both were verified by running them.

`parseGovernedRegistry` (with the `ParsedRegistry` type now exported) is the only other new export from `campaign-governance.ts`. It is the existing `parseRegistry`, returning no experiments when there are issues.

---

## 3. Commands and results

All test runs used Node v24.18.0 with `node --experimental-strip-types --test --test-concurrency=1`.

| # | Command | Result |
| --- | --- | --- |
| 1 | RED: each new test file run before its implementation existed | Failed as expected: `does not provide an export named 'resolveRegistryCampaignLink'`; `ERR_MODULE_NOT_FOUND …/attribution-ledger-export.ts`; `ERR_MODULE_NOT_FOUND …/attribution-decision-report.ts`; ledger CLI test failed before the script existed. The `unit` field was added RED-first as well (2 failing, then green). |
| 2 | Focused: `tests/attribution-ledger-export.test.ts tests/attribution-decision-report.test.ts tests/campaign-registry-link.test.ts tests/campaign-governance.test.ts` | exit 0. **49 tests, 49 pass, 0 fail, 0 skipped.** Per file: 20 / 12 / 6 / 11. |
| 3 | Broad: 129 test files matching `analytic\|attribution\|campaign\|decision\|ga4\|google-analytics\|meta-\|purchase\|stripe\|webhook\|payment\|refund\|order\|checkout\|print-upgrade\|settle`, run under `sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))'` | exit 0. **1877 tests: 1876 pass, 0 fail, 1 skipped.** The skip is the existing `production bundles carry no Vercel Analytics client, endpoint or queue` (# no production build present). |
| 4 | `npx tsc --noEmit -p tsconfig.json` | exit 0. The first run found 3 errors in my new CLI code (`TS2339 Property 'issues' does not exist`): `strict: false` does not narrow on `!result.ok`. I fixed all three to `result.ok === false`, which is the existing repo idiom. |
| 5 | `git diff --check` and a trailing-whitespace / final-newline scan of the untracked files | clean |
| 6 | `node --experimental-strip-types scripts/analytics-governance.ts check` | exit 0: `OK experiment_registry experiments=0`, `OK ga4_admin_checklist`, `OK decision_packet_mapping`, `OK meta_server_purchase DEFERRED` |
| 7 | Mutation pass, in a scratch copy outside the worktree (since deleted) | **66 targeted mutant runs** (49 + 17; 5 of the 17 re-anchored earlier mismatches). All killed except one equivalent mutant. See §4. |
| 8 | `graphify update .` | exit 0. 706 files re-extracted: 4256 nodes, 9296 edges, 181 communities, written to `graphify-out/` (git-ignored). |

**Not completed:**
- **Full `npm test`.** A background run was stopped by a session interruption before it finished (about 3,300 results logged, none failing up to the point of interruption). Its truncated tail shows `✖ tests/www-apex-redirect.test.ts — 'Promise resolution is still pending but the event loop has already resolved'`, consistent with the process being killed mid-file. I did not re-run the full suite (per the narrowed instruction), so I make **no full-suite claim**. That file is outside the changed surface; no app or middleware code imports a changed module.
- **`npm run build`.** A network-denied build in a scratch copy with a cloned `node_modules` was interrupted at `Creating an optimized production build …` and was not re-run. **Not verified.** No app route imports a changed module.
- **Lint.** Not run.

---

## 4. Mutation evidence (rules → mutant killed)

Each mutant was applied alone to a scratch copy, and the relevant test file was run.

- **Exclusions:** internal disposition, cohort/invite, unpaid, $0, invalid-record routing.
- **Tuple fields:** source, medium, campaign, content and landing path each removed from the match. Window start and end made exclusive. Capture day taken in UTC instead of the export timezone. Ambiguity guard removed. Partial missing its campaign condition. Primary model without the first-touch fallback, and primary model using the first touch.
- **Money:** refund-in-flight, partial-refund bounds, full refund above settled, `net_paid_orders`, `net_settled_cents`, upgrade folded into settled, upgrade status ignored, day from `createdAt` instead of `paidAt`, attribution accept window, tracking canonicality.
- **Report:** GA4 and registry origin checks, timezone, registry identity, ledger and GA4 coverage, attestation, integrity, denominator ambiguity, evaluable statuses, denominator gate inclusive, events gate, model filter, segment filter, GA4 content filter, GA4 window filter, ledger window filter, exclusion window, GA4 purchase substituted as the event count, gross vs net, both authority labels, the declarations list.
- **Link:** paused made linkable, planned made unlinkable, unknown id, invalid registry, id format, wrong entry.
- **Validator:** totals, model totals, segment grammar. **Fingerprint:** key-order canonicalization.

**Test gaps the mutation pass found and closed:**
- Exclusion window: the fixture had no excluded order outside the window. I added one.
- Three of my first mutants hit the wrong occurrence (a sibling constant and a type annotation). I re-anchored them, and they are now killed.

**Equivalent mutant.** Disabling only the builder's `COVERAGE_AFTER_GENERATED_AT` check survives, because the builder revalidates its output through the validator's identical check. Disabling both copies is killed.

---

## 5. Limitations and decisions for the reviewer

1. **Owner/QA/F&F/sample/test exclusion depends on durable markers.** It uses only `internalDisposition` and `checkoutTracking.cohort|invite`. The repo has no other durable owner, test or sample marker, and I did not invent a classification (for example by email or order id). An unmarked internal order is counted, and the report declares `UNMARKED_INTERNAL_ORDERS_COUNTED`. Marking every such order before a run is an operator precondition, as in audit §7.
2. **The snapshot producer is not built.** The CLI reads a directory of order JSON files. Exporting that snapshot from the Blob store read-only is a separate authorized step.
3. **Undated integrity rejections block every decision report.** Any unparsable record in the snapshot does this until it is fixed or removed. This is deliberate fail-closed behaviour.
4. **Late conversions are not counted.** An order paid after `end_date` is not in the window (`LEDGER_PAID_DAY_WITHIN_WINDOW`). Ledger days are paid days; GA4 days are session days.
5. **Denominator model.**
   - GA4 sessions are matched on the four-field tuple across all landing pages, because under the 30-day last-UTM model return visits land elsewhere. A co-tuple experiment on another landing path with an overlapping window refuses the report.
   - Ad-blocked sessions are missing from the denominator, so rates are biased upward. Both points are declared in the report.
6. **Paid-order definition.** `paid_order_rate` uses **net** paid orders: a full refund or dispute is not a sale, and a partial refund still is. Gross `paid_orders` and the refund columns are reported alongside.
7. **Print upgrades** are attached to the original order's paid day and segment (a cohort view), reported separately, and excluded from every outcome. A refund of an upgrade itself is not modeled by the repo and is not represented.
8. **Registry status.** Membership in `registered:<id>` ignores status. Evaluation requires `running`, `paused` or `completed`; links require `planned` or `running`.
9. **Data origins** of the ledger, the GA4 export and the registry must all be equal. The checked-in registry is `operator_export`, so synthetic exports cannot be joined against it.
10. **No README update.** `docs/analytics/README.md` §"decision packet" still says the ledger and app exports are "out of scope here". I left docs untouched; a follow-up docs-only change can point to the new CLI.
11. **Still open from the audit** and not touched here: S4 registry entry (owner values), S5 privacy disclosure (owner/legal), S6 GA4 host gate, S7 GA4 Admin completion, and the external GA4 proofs (G1–G4).

---

## 6. Status

`IMPLEMENTED_LOCAL_UNCOMMITTED — READY_FOR_INDEPENDENT_REVIEW`

The focused suites (49/49), the broad analytics/payment/order set (1876 pass, 0 fail, 1 build-dependent skip), `tsc` and `git diff --check` are green. The full `npm test`, the production build and lint were not completed in this session and are not claimed. Nothing is committed. The next step is an independent exact-byte review of the eight files above (hashes in §1), then a commit and PR on explicit instruction.
