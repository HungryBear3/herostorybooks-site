# Worker fix report: B1 and B2 only (synthetic milestone; full rehearsal NOT READY)

Author: Claude (sole remediation author; the prior author has exited). This is **not** self-acceptance. An independent final review is still required.

## Scope actually touched
| File | Change |
|---|---|
| `src/lib/paid-order-handoff-store.ts` | B1: `listEvents(orderId, limit, lanes = both)` |
| `src/lib/paid-order-handoff-worker.ts` | B2: one-read bounded snapshot and validation; passes lanes to `listEvents` |
| `tests/paid-order-handoff-worker.test.ts` | New B1/B2 tests; four existing expectations updated (listed below) before fix-red |
| `WORKER-FIX-REPORT.md` | This file (new) |

`src/lib/paid-order-handoff-fake.ts` is unchanged (sha256 `791e9a70…f27e`, same in green, fix-red and fix-green). No other candidate files, N2/route/outbox/core files, or global config, skills or memory were written. No Git, installs, network, credentials or real transports were used. The only Bash commands were the two exact wrapper invocations below.

## B1: starvation
- The store now filters to **actionable** events inside the same read transaction, *before* applying the limit. An event is actionable when at least one requested lane is non-terminal (not `delivered`/`dead_letter`) and `eligible(...)`.
- `truncated` is computed over the actionable set only.
- `lanes` defaults to `['owner','agent']` for API compatibility. Anything other than an array of 1–2 known lanes, including holes and throwing accessors, rejects with `invalid_lanes` before any transaction.
- The worker passes its deduped lanes to `listEvents`. Per-lane classification inside a listed event is unchanged. A lane that is already terminal while the other lane is actionable is still reported as `terminal`.

## B2: input snapshot
- `parse()` reads every input property once by destructuring. Each array is read through `snapshot()`, which:
  - checks `Array.isArray` and checks `length` against the bound (`orderIds` ≤ 100, `lanes` ≤ 2) **before** allocating or iterating;
  - rejects holes (`Object.hasOwn`);
  - reads each element once into a dense copy.
- Only the snapshots are validated and used afterwards. Lanes are deduped from the snapshot; order IDs are deduped from the snapshot.
- `transports[lane]` is read once per lane. Store and transport methods are bound once during parsing, so later getter changes cannot swap them after validation.
- Any exception thrown while parsing (getter, Proxy trap, `length` accessor) returns `invalid_input` with zero attempts and no echoed text.
- **Intentional bound:** more than two lane entries (e.g. `['agent','owner','agent']`) is now `invalid_input` rather than being deduped. Fewer than two entries with duplicates (`['agent','agent']`) is still deduped.

## Test changes (all made BEFORE fix-red; none after)
New tests:
- `terminal and ineligible prefixes never starve a later pending event`:
  - Setup: 2 terminal events, then 2 ineligible events (`revenue: unknown` / `zero_total`), then `half` (owner delivered, agent pending), then `late` (pending).
  - Listings: `limit 1` gives `[half]` with `truncated: true`; `['owner']` gives `[late]` with `truncated: false`; `['agent']` gives `[half, late]`.
  - Invalid `lanes` rejects with zero transactions.
  - Running with `maxEventsPerOrder: 2` delivers `half` (agent) and `late` (both lanes) in one invocation.
  - Repeat runs produce no results and no calls (3 transport calls total).
- `sparse, oversized, throwing or changing input arrays never reach the store`:
  - Rejected as `invalid_input` with zero transactions and zero transport calls:
    - `orderIds` holes, including length `2**32-1`;
    - `lanes` holes, including length 1,000,000;
    - a 3-entry lanes array;
    - throwing element getters for both arrays;
    - a throwing `length` Proxy trap;
    - a throwing `orderIds` property getter on the input.
  - Element getters that change between reads: only the first-read values (`ord_w1`, `owner`) are used. The later values (`ord_zz`, `admin`) are never seen.

Existing expectations consciously updated (they change because of the B1 listing semantics or the B2 lane bound):
1. `both lanes deliver once…`: repeat runs after full delivery now return `{completed, attempts 0, results: []}` (was `['terminal','terminal']`). The no-resend assertions are unchanged.
2. `duplicate order ids and lanes…`: the input `['agent','owner','agent']` exceeds the 2-lane bound. The test now dedupes `['agent','agent']` instead, asserts that the 3-entry form is `invalid_input`, and asserts that a follow-up two-lane run delivers owner and reports agent `terminal`.
3. `owner/agent: refund between claim and validate…`: the second run's results are now `[]` (was `['ineligible']`), because refunded events are not listed. The zero-send assertions are unchanged.
4. `busy, terminal, missing and store-error…`: `ord_dead` (agent `dead_letter`, lanes `['agent']`) no longer produces a row. The other rows, the isolation, the sanitization and the direct `command` → `terminal` assertion are unchanged.

Observable consequence: an order whose events are all terminal or ineligible in the requested lanes now produces **no** result row, rather than one `terminal`/`ineligible` row per event and lane. Callers that need per-order confirmation must infer it from that absence. A reviewer may want an explicit order-level status. I did not add one because it would widen the status set beyond B1/B2.

## Exact commands and results
1. `python3 /Users/abigailclaw/.hermes/cache/scratch/hsb-fa5a8ab-worker-20261021/run-tests.py fix-red`
   - Exit 1: 38 tests, 31 pass, **7 fail**, all with `AssertionError` (none from the loader).
   - Failing tests: both-lanes repeat, duplicate lanes, B1 starvation, B2 input arrays, owner refund, agent refund, busy/terminal.
   - The wrapper's assertion passed, so all three sources were byte-identical to `initial/` at the time.
   - Worker test sha256: `eb4e929e700abf950bc255f8247ba744b15b028696146bf40c9d365c338efc44`.
2. `python3 /Users/abigailclaw/.hermes/cache/scratch/hsb-fa5a8ab-worker-20261021/run-tests.py fix-green`
   - Exit 0: 38/38 pass, 0 fail, 0 cancelled.
   - The worker test sha256 is the **same** `eb4e929e…fc44`, so the tests were not modified after fix-red.
   - Source hashes: store `3cdf9758731e549e42f2bb911503acc385acabe8833750df0df220af9895a627`, worker `7dd58f228c7b1dc4e2971496759acdd028e5a960f8537c84609340235b08dda9`, fake `791e9a70ed604901c455c0b33c2e4c0f86d31871ba898872d9c44848a262f27e` (unchanged).
   - The frozen core tests match the original green receipt exactly: `tests/paid-order-outbox.test.ts` `1e0cf17f…80c6` and `tests/paid-order-handoff-secrecy.test.ts` `37b69930…d7b1`. All 17 outbox and 4 secrecy tests pass.

Logs and receipts: `evidence/fix-red.{log,json}` and `evidence/fix-green.{log,json}`, written by the wrapper.

## Nonblocking limits carried forward (from INITIAL-REVIEW, still unaddressed by design)
1. The transaction shape is structurally matched but not compiler-verified (no `tsc`; no `satisfies typeof withOrderTransaction`).
2. `validate` freshness under production `preferRecentCommit` caching is a production-wiring gate, and the synthetic store cannot show it.
3. The factory returns `outcome.delivery`/`outcome.event` uncloned. Isolation comes only from the synthetic transaction.
4. `events(order)` still materializes the full history per read. B1 now filters that array but did not make it lazy. The cost is bounded by the already-loaded record.
5. The invocation has no wall-clock bound. A hanging store hangs the worker.
6. `transportTimeoutMs` has no sensible floor (1 ms is accepted).
7. Reads are wasted after the attempt budget is exhausted (up to 100 `listEvents` transactions).
8. In the refund case the worker reports `ambiguous` with zero sends, and the lane stays `leased` until expiry.
9. Enrollment checks `kind === 'new_paid_order'` only, not the `paidEvent` identity.
10. Test fault-detection gaps remain:
    - deleting `enrolled(order) &&` from `validate` is not detected;
    - no test checks for pending timers or `clearTimeout`;
    - untested: ack-commit failure after a send, agent reconcile timeout, and the worker-level `claim` → `terminal` path. The busy-test row for that path was removed by B1, so this gap is slightly wider. The direct store `command` → `terminal` assertion remains.

New limit: the store's `listEvents` lane check uses `Array.from` after a length bound of 2. Holes become `undefined` and are rejected. Unlike the worker, it does not separately check `Object.hasOwn`, so a polluted `Array.prototype` index could fill a hole. Its only in-repo caller, the worker, always passes a dense validated snapshot.

## Remaining full-plan gates (unexecuted)
These remain NOT_RUN:
- real persistence and restart behavior;
- production store adapter and route wiring;
- credentials, recovery and fence revocation;
- stop-alert, admin and $0 workflows, and N1;
- Node compatibility, the full suite, typecheck and build;
- real transports and the full rehearsal.

This synthetic milestone is **not** full rehearsal readiness. **Full rehearsal: NOT READY.**
