# CC-FINAL-HANDOFF — HSB Lane A incident observability

Task: `CC-HSB-LANE-A-OBSERVABILITY-20260824`
Status: **CONTROLLER-CORRECTED LOCALLY — HELD FOR FRESH EXACT-SHA REVIEW. NOTHING ACTIVATED.**

## 1. Exact base and workspace

| Item | Value |
| --- | --- |
| Repository | `/Users/abigailclaw/herostorybooks-site` |
| Required base | `ba3533bfaefc6c13cec4b55861b178db12605d1d` |
| `origin/main` at start of work | `ba3533bfaefc6c13cec4b55861b178db12605d1d` |
| Base drift | **NONE** — verified before any edit |
| Worktree | `/Users/abigailclaw/cc-worktrees/hsb-incident-observability-20260824` (new, isolated) |
| Branch | `cc/hsb-incident-observability-20260824` (new, cut from the exact base) |
| Commit parent | `ba3533bfaefc6c13cec4b55861b178db12605d1d` |

`ba3533b` is `fix(hsb): converge terminal Stripe payment events (#146)` — the merged payment
convergence candidate the reconciliation named as the Lane A prerequisite. That prerequisite is
therefore satisfied by the base itself, not deferred.

**HEAD / tree of this commit:** read them from git as the authoritative source —

```
git -C /Users/abigailclaw/cc-worktrees/hsb-incident-observability-20260824 rev-parse HEAD
git -C /Users/abigailclaw/cc-worktrees/hsb-incident-observability-20260824 rev-parse HEAD^{tree}
```

They are deliberately not transcribed into this file: this file is part of the committed tree, so
any value written here could not be the hash of the object containing it.

### Source-snapshot fidelity

Every file in the handoff `source-snapshot/` was SHA-256 compared against the worktree at the base
before any edit. All 12 compared paths matched exactly (detector, runtime, route, order-stage,
order-diagnostics, orders, cron-auth, fulfillment-types, vercel.json, and the three test files).

## 2. What was wrong, and what changed

The audited defect: the stranded detector was **structurally incapable of firing**. It required
`fulfillmentMode === 'auto'`, which no order-creation path sets, so a scheduled run would have
reported `scanned: N, candidates: 0, HTTP 200` over a completely uncovered surface. It also wired
the permissive `listOrders` (whose storage fallback turns an outage into `scanned: 0` + HTTP 200)
and swallowed alert-sink exceptions while still returning success.

| Prompt requirement | Where it landed |
| --- | --- |
| 1. Use fail-closed `listOrdersAuthoritative`, never permissive `listOrders` | `stranded-order-detector-runtime.ts` wires `listOrdersAuthoritative`; the `ScanDeps` field is *named* `listOrdersAuthoritative` so the contract is enforced at the type level. Test `2d` asserts (on comment-stripped source) that neither the core nor the runtime names the permissive helper. |
| 2. Pure incident classification for all eight cases | New `src/lib/order-incident.ts` — `classifyOrderIncident`. |
| 3. Classifier shared by detector, `deriveOrderAttention`, `classifyPaidOrderOpsIssue`, no cycle | All three import `order-incident.ts`; it imports none of them and only `import type { OrderRecord }`. Dependency direction is strictly one-way. |
| 4. Identity = `orderId + incidentClass + state-entry/attempt fingerprint` | `OrderIncident.dedupKey` = `` `${orderId}::${incidentClass}::${fingerprint}` ``. Cooldown state is keyed by that, never by order id. |
| 5. Local structured logging only, PII-free | `defaultIncidentSink` in the runtime is a single `console.error` line. No email/name/address/token/Stripe id/artifact URL/story text/feedback anywhere in the payload or the log lines. |
| 6. Sink + cooldown failure must fail/degrade; no clean HTTP 200 | `runIncidentScan` returns `failed: true` with `reason: 'alert_sink_failed'` / `'cooldown_persist_failed'`; the route returns 500 on `failed`. Data-quality uncertainty sets `degraded: true`. |
| 7. Refunds must never alert merely because refund finalization uses `failed_manual_review` | `isTerminalOrExcluded` checks `refundedAt`, `paymentStatus in {refunded, partially_refunded}`, `stripeRefundId`, and `refundClaimId` — the exact field set `updateOrderPaymentReversal` writes — *before* the `failed_manual_review` branch. |
| 8. Ambiguous print visible in admin attention AND paid-order diagnostics even with an artifact | `deriveOrderAttention` checks it first; `classifyPaidOrderOpsIssue` checks it before the `storyArtifactUrl` early-return that used to hide it. |
| 9. No order state or fulfillment behavior change | Zero writes added. `deriveOrderStage` untouched. `orders.ts`, `fulfillment.ts`, `order-email.ts` untouched. |

### The taxonomy

| Class | Severity | Retryable | Trigger |
| --- | --- | --- | --- |
| `print_submission_ambiguous` | critical (rank 100) | **never** | `submitting_to_print`, no `printJobId`/`printJobStatus`, and either the `print_submission_ambiguous` error prefix or a crossed `printSubmissionAttemptedAt` fence |
| `failed_manual_review` | high | yes | genuine failure, after every refund/terminal exclusion |
| `stale_in_progress_no_lease` | high | yes, except `submitting_to_print` | in-progress state with no live kickoff lease, past threshold |
| `auto_not_started` | high | yes | explicit `auto` intent, `not_started`, past threshold |
| `delivery_email_failed` | high | yes | artifacts fine, notification failed |
| `data_quality_uncertain` | medium | no | missing/invalid/future `paidAt` or state-entry stamp; unset `fulfillmentMode` |
| `manual_hold_sla` | medium | no | explicit `manual_hold` past its operator SLA |
| `customer_review_wait_overdue` | medium | yes | `proof_ready`/`proof_approved` past its own (much longer) SLA |

Default thresholds (design/testing values, all env-overridable, none activated): manual-hold SLA
24 h; auto-not-started 12 h; stale-in-progress 60 min; lease TTL 6 min (mirrors
`FULFILLMENT_KICKOFF_TTL_MS`); customer wait 14 d; alert cooldown 24 h.

## 3. Changed files — inside the allowlist, nothing outside

Production (5 allowed + the 1 permitted new pure helper):

```
src/app/api/internal/stranded-scan/route.ts
src/lib/order-diagnostics.ts
src/lib/order-stage.ts
src/lib/stranded-order-detector-runtime.ts
src/lib/stranded-order-detector.ts
src/lib/order-incident.ts                      (NEW — the one permitted pure helper)
```

Tests (3 allowed + 1 new narrowly named):

```
tests/order-diagnostics.test.ts
tests/order-stage.test.ts
tests/stranded-order-detector.test.ts
tests/order-incident-classification.test.ts    (NEW)
```

Plus this handoff, `CC-FINAL-HANDOFF.md`.

**Confirmed untouched:** `vercel.json` (no cron added — still only the pre-existing
`/api/cron/fulfillment-sweep` line), `src/lib/orders.ts`, `src/lib/fulfillment.ts`,
`src/lib/order-email.ts`, every admin React page, checkout, payment/webhook code, Blob storage
mode, book-generation code, and all other tests.

## 4. RED → GREEN evidence

Every suite was written and run RED before the implementation existed.

| Suite | RED result | GREEN result |
| --- | --- | --- |
| `tests/order-incident-classification.test.ts` (new, 31 tests) | `ERR_MODULE_NOT_FOUND: src/lib/order-incident.ts` — 0 pass / 1 fail | 31 pass / 0 fail |
| `tests/stranded-order-detector.test.ts` (26 → 28 tests) | import error — `runIncidentScan` did not exist — 0 pass / 1 fail | 28 pass / 0 fail |
| `tests/order-stage.test.ts` (10 → 14 tests) | 11 pass / **3 fail** (ambiguous print returned `none`) | 14 pass / 0 fail |
| `tests/order-diagnostics.test.ts` (12 → 18 tests) | 15 pass / **3 fail** (`classifyPaidOrderOpsIssue` returned `null`) | 18 pass / 0 fail |

RED coverage for each item the prompt named: manual hold below/at/above SLA; auto not-started
below/at/above threshold; refunded and partially-refunded `failed_manual_review` exclusions (plus
in-flight refund claim, internal, shipped, delivered, complete); active lease exclusion vs stale
no-lease incident (plus future-lease clock fail-closed); ambiguous print with an existing artifact
is highest severity (plus fence-only, reconciled-job-id clears, survives refund); customer review
wait exclusion and its own-SLA incident; authoritative enumeration throw and partial-cursor
ambiguity; alert failure fails the scan and does not advance cooldown (plus partial-failure keeps
successful cooldowns); cooldown write failure fails the scan; stable dedup key that changes on a
new attempt, a new state entry, and a new print attempt; PII absence from payload **and** log
lines (plus error sanitization); invalid auth and missing `CRON_SECRET` fail closed.

## 5. Commands and exit codes

All run in the isolated worktree at the exact base.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | 247 packages |
| `node --experimental-strip-types --test tests/order-incident-classification.test.ts` | 0 | 31/31 |
| `node --experimental-strip-types --test tests/stranded-order-detector.test.ts` | 0 | 28/28 |
| `node --experimental-strip-types --test tests/order-stage.test.ts` | 0 | 14/14 |
| `node --experimental-strip-types --test tests/order-diagnostics.test.ts` | 0 | 18/18 |
| `npm test` | 0 | **1542 / 1542 pass, 0 fail** |
| `npm run build` | 0 | compiled clean |
| `npx tsc --noEmit` | 2 | 54 errors — see attribution below |
| `npm run test:e2e` | 0 | **99 / 99 passed** |
| `git diff --check` | 0 | clean |
| `npm run lint` | 127 | `eslint: command not found` — see below |

Baseline for comparison, measured on the untouched base before any edit: `npm test` **1499/1499**,
`npm run build` exit 0, `npx tsc --noEmit` exit 2 with 54 errors.

Test delta: **+43** (1499 → 1542) = 31 new + 4 + 6 + 2.

### Baseline-attributed diagnostics

`npx tsc --noEmit` reports **54 errors before and 54 after**. The two sorted error sets are
**byte-identical** — `diff` produces no output, i.e. **0 new and 0 resolved**. All 54 live in
`tests/` (pre-existing fixture/target-level issues in `image-prompt-text-safe`,
`order-route-required-fields`, `order-stage`, `post-stripe-confirmation`, `recovery-sweep`,
`review-private-flow`, `seo-indexing-surfaces`). **`src/` has 0 TypeScript errors, before and
after.** An earlier reading of exit 1 came from a stale `incremental` build cache; re-measured with
the cache cleared, both base and candidate exit 2.

`npm run lint` fails identically at the base: `eslint` is referenced by the `lint` script but is
not in `devDependencies` and is not installed. **Not a regression introduced here**, and not
something this lane's allowlist permits fixing.

`graphify update .` was **not run**: this repository has no `graphify-out/`, and the task manifest
itself lists `graphify-out/GRAPH_REPORT.md` under `missing_optional_paths`. Graphify is not
configured for `herostorybooks-site`, so there is no graph to update and no graph output in the
commit.

### Added-line credential / PII / debug scan

All 1,877 added lines scanned. Zero findings for: Stripe live/test keys, publishable keys, webhook
secrets, AWS keys, PEM blocks, real bearer tokens, real email addresses, production-shaped order
ids (`ord_<16+ hex>`), Stripe/provider object ids (`ch_`/`re_`/`pi_`/`cs_`…), `debugger`,
`console.debug/dir/trace`, `.only(`/`.skip(`, `FIXME`/`XXX`/`TODO`, the repo's REQ16 banned
identifiers, and any collision-boundary path.

Two matches are intentional and inert: a synthetic string `vercel_blob_rw_ABCDEFGH12345678` and
`secret.parent@example.com`, both fixtures inside the redaction test that asserts they are stripped
from log output. All other addresses are `@example.com` test fixtures.

**One real guard fired and was fixed rather than suppressed.** `REQ16` in
`tests/review-snapshot-and-guards.test.ts` bans a production-shaped `ord_<16+ hex>` literal in any
committable file. The base `tests/stranded-order-detector.test.ts` carried exactly such a literal
(the July 13 founder fixture reference), and escaped the guard only because that file was outside
the guard's changed-file scan set. Touching the file brought it into scope, and the guard failed. The fixture
was replaced with a synthetic `ord_internal_test_fixture`; the guard test itself was **not**
modified (it is outside this lane's allowlist, and weakening it would have been the wrong fix).

## 6. Side-effect attestation

Nothing outside the isolated worktree was created, modified, read, or invoked.

- **No** push, PR, merge, deploy, alias, cron, or schedule. The commit is local and unpushed.
- **No** `vercel.json` cron line. **No** Resend/email/Discord/Slack/Telegram/webhook alert code —
  test `8e` asserts the runtime's code contains none of those tokens and that `vercel.json` never
  names `stranded-scan`.
- **No** Production route invocation. **No** order, customer, Stripe, Blob, Lulu, or provider
  access of any kind. Every test uses injected in-memory fakes.
- **No** environment reads beyond reading source files in the worktree. New env var *names* were
  added to the config loader as code; no `.env` was read and no live environment was inspected.
- **No** order-creation path was set to `auto`; no fulfillment mode was changed anywhere.
- **Collision boundary respected in full.** Every path the task brief fenced off — the shared
  book-generation run directory and media directory under `~/.openclaw/workspace/`, story art, page
  images, manuscripts, proof PDFs, print files, Waterfall/Pasta/Mark artifacts, and customer
  Blob/Production order data — was never read, written, renamed, hashed, rendered, or inspected.
  Abigail's regeneration runs were not touched.
- Existing HSB worktrees were left alone; a new one was created for this lane.
- `npm ci` installed into this worktree's own `node_modules` (gitignored, not committed).

## 7. Judgment calls a reviewer should rule on

These are deliberate decisions, not oversights. Each is tested and reversible.

1. **Ambiguous print is exempt from the refund/internal-disposition filter.** The reconciliation
   scopes refund exclusion to "stranded/manual-review incidents", and requirement 7 says refunds
   must not alert *merely because* refund finalization uses `failed_manual_review`. Refunding a
   customer does not un-submit a physical book, so an unreconciled provider submission still needs
   an operator. If you want ambiguous print silenced on refunded orders, move the
   `isPrintSubmissionAmbiguous` check below `isTerminalOrExcluded` in `classifyOrderIncident` and
   below the refund early-return in `deriveOrderAttention`.
2. **`submitting_to_print` is inside the stale-in-progress set**, not only the ambiguous path. The
   prompt says "stale generating/building states"; a non-ambiguous order parked at
   `submitting_to_print` is the same false-green hole. It is force-marked `retryable: false`.
3. **Unset `fulfillmentMode` on an old paid `not_started` order is `data_quality_uncertain`**, not
   `manual_hold_sla`. We genuinely cannot tell the routing intent, and inventing one would be a
   guess. Consequence: legacy orders past 24 h will classify as data-quality and mark scans
   degraded. That is the honest reading of the audit finding, but it is also the noisiest default
   in this change.
4. **`customer_review_wait_overdue` is a class the prompt implies rather than names.** Requirement
   2 says customer waits are non-incidents "before their own threshold"; this is the after side.
5. **`classifyPaidOrderOpsIssue` now returns a non-artifact issue kind.** The unmodified
   `/api/admin/orders?opsIssue=paid_artifact` filter therefore now also surfaces ambiguous-print
   orders. That is requirement 8 working, but the query-parameter name is now slightly narrower
   than what it returns. Renaming it would require touching a file outside the allowlist.
6. **`flags.paidWithoutArtifact` / `paidArtifactNeedsAttention` were re-derived from the issue
   *kind*** rather than from "an issue exists", so an ambiguous-print order that *has* an artifact
   does not get flagged as missing one. Existing semantics for all five original kinds are
   unchanged and regression-tested.
7. **Test `8a` was relaxed from "type-only imports" to "type-only, plus the pure classifier".**
   The underlying invariant is reachability, and the classifier's own purity is separately asserted
   in both files. Requirement 3 (a shared classifier) cannot coexist with a literal type-only rule.
8. **Two source-level assertions now strip comments before matching.** Explaining *why* the
   permissive list helper and external channels are forbidden requires naming them in prose; the
   assertions must therefore test code, not documentation.

## 8. Residual activation gates — all still closed

Nothing in this change is live. Before any of it produces an operator alert:

- **No cron exists.** Adding a `vercel.json` entry for `/api/internal/stranded-scan` remains the
  final step, and per the reconciliation it comes only after a deterministic zero-send run proves
  complete enumeration, taxonomy, deduplication and failure signaling.
- **No external channel exists.** Recipient and cadence are activation-time operator configuration
  awaiting Alexy's approval of the exact channel and cadence. The sink is `console.error` only.
- **Route auth still requires `CRON_SECRET`**, which is unset by default → 503 fail-closed.
- **Thresholds are unvalidated against real data.** They are conservative design defaults chosen
  here, not operator-approved SLAs. New optional env overrides:
  `HSB_INCIDENT_MANUAL_HOLD_SLA_HOURS`, `HSB_INCIDENT_STALE_IN_PROGRESS_MINUTES`,
  `HSB_INCIDENT_LEASE_TTL_MINUTES`, `HSB_INCIDENT_CUSTOMER_WAIT_HOURS`. The pre-existing
  `HSB_STRANDED_THRESHOLD_HOURS` and `HSB_STRANDED_ALERT_COOLDOWN_HOURS` keep their meanings.
- **Order creation still does not set `auto`.** Per reconciliation decision 1, that was
  deliberately not changed; `auto_not_started` will therefore match nothing until a workflow is
  separately approved to designate `auto`. Unlike before, this is now one class out of eight rather
  than the detector's entire coverage.

## 9. Known gaps this lane did not close

Stated plainly rather than left for a reviewer to find:

- **The cooldown blob is still `access: 'public'`** and still grows without pruning. Entries are
  order ids and timestamps only, but the public default is a finding from the Slice 4a audit and
  the unbounded growth is new pressure from per-incident (rather than per-order) keying. Both were
  out of this lane's stated goal; neither is fixed here.
- **`sendOperatorFailureAlert` in `src/lib/fulfillment.ts` is unchanged** and still contains
  customer email and child name. This lane built the new redacted sink alongside it as instructed
  and did not touch `fulfillment.ts`; retiring the old alert is separate work.
- **No production data was used to validate the taxonomy.** Every case is synthetic. The audit's
  claim that the taxonomy matches real stuck-order shapes has not been checked against live orders,
  and doing so was outside the collision boundary.

## 10. Stop point

Work stopped at the local commit, as instructed. No push, no PR, no merge, no deploy, no schedule,
no external action. The branch `cc/hsb-incident-observability-20260824` awaits independent
exact-SHA review.

## 11. Controller correction after first independent BLOCK

The first independent review bound to `97441186adccb0e7a26074cb10dcb921791fc5ed`
returned BLOCK with five findings. That target is superseded.

Final cumulative code target:

- commit: `41903733b2d50df2ab9558f0259a555bded1e474`
- tree: `a66debd2e00a9e241de2c1dd167ddfd5107730e0`
- parent: `97441186adccb0e7a26074cb10dcb921791fc5ed`

Correction behavior:

1. Unset `fulfillmentMode` is data-quality uncertainty immediately after
   payment; it no longer waits 24 hours while appearing clean.
2. Degraded scans now set `ok:false`, and the route returns HTTP 500 for either
   `failed` or `degraded`.
3. `safeErrorCode` uses a strict internal allowlist; provider IDs, secret-key
   shapes, capability tokens and arbitrary bare identifiers map to
   `unclassified`.
4. Failure dedup identity uses fulfillment/email attempt-specific timestamps
   and counters, never broad `updatedAt`. An unrelated order edit no longer
   bypasses cooldown; a new attempt or email resend claim still does.
5. `opsIssue=paid_artifact` retains its historical missing-artifact meaning.
   Ambiguous print remains visible in attention and diagnostics but does not
   silently enter that named filter.
6. Future or malformed cooldown timestamps fail the scan before any alert.

The controller extended scope by exactly one production route,
`src/app/api/admin/orders/route.ts`, to preserve its existing query contract.
No React admin page was changed.

RED: the new blocker suite failed in each of the five required areas before
production edits. GREEN: focused 96/96, full 1547/1547, build PASS, E2E 99/99,
TypeScript remains the same pre-existing test-only diagnostic set,
`git diff --check` is clean, and the added-line secret/debug/external-call scan
found zero matches.

Still closed: no cron, no external channel, no live order census, no approved
thresholds/cadence, and cooldown storage is still public/unbounded. Nothing in
this correction activates the route or performs an external action.
