# AUTHOR-REPORT — mounted admin handoff route on the enrolled store + same-run recovery identity/replay

Author: Claude (sole author). Author report only; **no self-acceptance**. Predecessor: frozen manifest `evidence/base-pins.json`. No Git ancestry is claimed. Elon's HARNESS-2 oracle, classroom and other lanes were not touched or duplicated.

## Changed paths (all within the write ceiling)
- `src/lib/paid-order-handoff-store.ts` — `createHandoffStore` gains `listAll` (the full N2 safe list, terminal history included) and `recover` (same-run recovery that needs a server-derived actor). Adds `parseRecoveryInput` and `PRINCIPAL_PATTERN`. `command` now refuses `recover_accepted_run` (`recovery_requires_actor`). `command`, `listAll` and `recover` outputs are deep clones.
- `src/lib/paid-order-handoff-route.ts` — every list and command now goes through a `HandoffEventStore`. The route no longer imports or calls `mutateOutbox`/`events`. New optional deps: `store` and `principal(request)`. The old `transact` dep is still accepted, but it is adapted to a `HandoffTransaction` and wrapped in `createHandoffStore`, so the enrollment rules apply to it too. Exports `HSB_ADMIN_PRINCIPAL = 'hsb-admin'`.
- `src/app/api/admin/orders/[orderId]/handoff/route.ts` — the mounted route now builds `createHandoffStore` over `withOrderTransaction(..., { notFound, fresh: true })`. Auth uses `isAdminAuthedFromRequest` from `admin-auth`, and the manual-media/provider runtime import is gone. The principal is `'hsb-admin'` only when the shared admin credential authenticates.
- `src/lib/paid-order-outbox.ts` — additive only: a `RecoveryAudit` type, and `Delivery.recoveries` typed as `RecoveryAudit[]` (new optional fields). The state machine is unchanged.
- `src/lib/orders.ts` — additive only: `withOrderTransaction` has a new `fresh?: boolean` option, `preferRecentCommit: attempt === 1 && opts.fresh !== true`. Callers that omit it behave as before.
- `tests/paid-order-handoff-integration.test.ts` — new file with 12 tests, written first.
- `tests/paid-order-handoff-secrecy.test.ts` — compatibility fixture change only, see below.
- `AUTHOR-REPORT.md` — this file.

## Behaviour
- **Enrollment.** List and every command go through the store. Legacy orders that only have a `workQueue` (no durable `new_paid_order` outbox entry) now get 409 for list and claim, and nothing is seeded. Before this change the route listed them, and a claim would have seeded them through the core.
- **List.** `listAll` keeps the old N2 row shape: `id, kind, version, owner, agent, ownerEligible, agentEligible, revenue, requiresAttention, blocked`. It covers all events, terminal history included, so it is not cut down to the actionable list. Like the old route, it is unbounded.
- **Recovery identity.** `recover_accepted_run` needs `deps.principal(request)` to return a valid principal. If it is absent, null, invalid or throws, the response is 403 and no transaction runs. Any `actor` in the request body is replaced by the server principal and is never stored.
- **Recovery input.** Required: `requestId` (`[A-Za-z0-9_-]{8,80}`), `expectedRevision` (integer 0..19), `evidence` (1..200 safe characters). Missing or invalid input gets 400 with zero transactions. The store re-validates and rejects with `invalid_recovery`.
- **One transaction.** All of the following happen inside a single `transaction()` call:
  - The enrollment check.
  - The requestId scan across every event and lane on the order:
    - same requestId with the same fingerprint → **returns the stored outcome** (`replayed: true`) and writes nothing, so the lease is not extended and no audit entry is added;
    - same requestId with a different fingerprint, event or lane → `request_conflict`.
  - The revision check: `expectedRevision` must equal the current `agent.recoveries.length`, otherwise `stale_revision`.
  - The core `mutateOutbox` recovery check (exact token, workToken and receipt; expired lease; eligibility; at most 20 recoveries) and the lease extension.
  - The audit entry `{ at, receipt, actor, requestId, expectedRevision, evidence, evidenceSource: 'operator_supplied_unverified', expiresAt, fingerprint }`.
- **Evidence** is operator-supplied text. It is **not provider-verified**, and the `evidenceSource` label says so.
- **Recovery response.** Lane-minimized `projectOutcome` plus `recovery: { replayed, actor, requestId, expectedRevision, evidenceSource, expiresAt }`. It contains no token, workToken, fingerprint, evidence text, or anything from the owner lane.
- **Deferred:** generation, takeover and dispatch. Only same-run recovery exists.

## Compatibility changes (explicit)
1. **Secrecy test fixture.** The recovery positive case in `tests/paid-order-handoff-secrecy.test.ts` now passes `principal: () => 'hsb-admin'` and adds `requestId`, `expectedRevision: 0` and `evidence` to the body. Without these the test necessarily fails, because they are now mandatory. Every secrecy assertion and the other 3 secrecy cases are byte-unchanged. No unsafe bypass was kept to make it pass.
2. HTTP recovery callers must now send `requestId`, `expectedRevision` and `evidence`, and new status codes exist: 403 `recovery_principal_required` and 400 `invalid_recovery`.
3. Legacy workQueue-only orders are now denied (409) on list and on commands.
4. The mounted route's auth source changed from `manualMediaProofRuntime.authenticate` to `isAdminAuthedFromRequest`. **I did not read `manual-media-proof-runtime.ts`, so I have not verified that the two accept the same credentials.**
5. `HandoffEventStore.command` refuses `recover_accepted_run`. The worker never sends it.

## TDD evidence (`run-tests.py`, sandbox-exec with network denied)
- **RED** (before any production edit; the wrapper's src pin check passed): exit 1. 11 of the 12 new tests failed on behaviour:
  - status mismatches, e.g. legacy list returned 200 instead of 409, recovery returned 409 instead of 403/400/200;
  - `r.store.recover is not a function`;
  - the mounted route could not load because `Cannot find package '@vercel/blob'` was reached through `manual-media-proof-runtime`.
  - The unauth/disabled zero-transaction test already passed, because that behaviour predates this change.
  - All 38 previous tests passed, including the updated secrecy fixture: the old route ignored the extra fields.
- **GREEN**: exit 0, **50/50 pass** (12 new + 38 previous: 19 worker, 4 secrecy, 15 outbox).
- **Same test bytes in RED and GREEN** (sha256 from `evidence/red.json` and `evidence/green.json`):
  - integration `3f53c382…b23510`
  - worker `eb4e929e…fc44`
  - secrecy `80a63fb6…12ce4`
  - outbox `1e0cf17f…080c6`

## New test coverage (`tests/paid-order-handoff-integration.test.ts`)
- **Legacy denial.** A workQueue-only order is denied list and claim through the store and through the old `transact` deps; nothing is seeded.
- **Enrolled order.** Full N2 list projection (exact keys, terminal row kept). Claim goes through the store. The generic command path refuses recovery.
- **Unauth/disabled.** 401/409 with zero transactions for list, recovery and claim.
- **Principal.** Missing, null, empty or invalid principal → 403 with zero transactions. A forged body actor is ignored: the audit records `hsb-admin`, and `eve-forged` appears nowhere.
- **Invalid input.** 14 bad requestId/revision/evidence bodies → 400 with zero transactions. Store-level `invalid_recovery`.
- **Accepted recovery.** Exact audit (principal, request, revision, evidence, unverified source, `at`, lease expiry), one lease extension, fence valid, owner lane unchanged, one commit.
- **Replay.** Same-request replay after the lease expires again returns the stored outcome with no lease or audit advance and no commit. The fence stays expired.
- **Conflicting reuse.** A changed evidence, revision or actor with a consumed requestId is refused with no effect.
- **Stale revision.** A stale revision with a new requestId is refused. The current revision then succeeds (2 recoveries).
- **Concurrency.**
  - (a) On the serialized synthetic fixture, exactly one of two concurrent recoveries succeeds and the other gets `stale_revision`.
  - (b) A test-owned optimistic CAS fixture uses a promise barrier (no sleep) so both calls read version 0. Exactly one conflict occurs, the loser re-reads and gets `stale_revision`, and the final version is 1.
- **Leakage and cloning.** No authority leaks from list or recovery (tokens, fingerprint, receipt). A pass-through (non-cloning) transaction shows that mutating `command`/`recover` outputs cannot change the held state.
- **Mounted `POST` from `route.ts`.**
  - A `node:module` `registerHooks` resolve hook maps `@/lib/*` to the real `src/lib/*.ts` and replaces **only `@/lib/orders`** with a JSON-string `withOrderTransaction` fixture. That fixture includes a read-your-own-writes cache, used to test the fresh binding.
  - Checked: 401 with no key and with a wrong key; 409 when disabled; zero transactions in all three; legacy order denied; full list; recovery with a forged body actor audited as `hsb-admin`.
  - Fresh binding: after an external refund, list shows the event ineligible and an owner claim gets 409. Every mounted transaction received `fresh: true`.
  - Restart: the fixture is serialized to JSON and rebuilt, and the lease is lapsed in the stored JSON. Replay returns `replayed: true` with no extension and no commit; conflicting reuse gets 409.
  - **This JSON roundtrip is a fixture only. It is not real orders persistence.**

## Limits / NOT_RUN
- **The `orders.ts` `fresh` option was never executed.** `node_modules` is absent from the candidate (`@vercel/blob` and `sharp` cannot load), so the real `withOrderTransaction` and blob/local adapters could not be imported. The mounted test checks that the route *passes* `fresh: true` and that a fresh-honouring persistence decides on current state. It does not prove orders.ts itself honours the flag. The change is a one-line conditional and needs controller verification.
- No typecheck (`tsc`), no Next build or route bundling, no full-app runtime, no real persistence/CAS adapter, no provider, transport, network or deploy. The only execution was the wrapper's 4 test files.
- **Shared principal.** `hsb-admin` names the shared admin credential (`HSB_ORDER_ADMIN_KEY` header or cookie), not a person. Anyone holding the key is indistinguishable in the audit, so the trail does not identify a named human.
- **Evidence is not verified.** Recovery trusts the operator's attestation and evidence text. There is no provider/run lookup.
- `listAll` keeps the old unbounded N2 semantics. It is not paginated.
- **Fingerprint.** The durable audit stores a sha256 request fingerprint whose input includes the token and workToken. Responses never return it, and the list does not expose it.
- **Replay after ineligibility.** A replay returns the stored outcome even if the order has since become ineligible (e.g. refunded). It grants no lease or authority, but the caller sees `replayed: true` rather than a refusal.
- **Body actor.** A body `actor` field is ignored silently, not rejected.
- Generation, takeover and dispatch recovery are deferred. Graph and wiki updates are left to the controller. There were no commits, installs or credential access, and no tool denials affected the result. One early `cat` was denied by the harness and replaced with Read.

---

## Previous milestone report (N2 response isolation), retained verbatim

# AUTHOR-REPORT — N2 response isolation (first finite milestone)

Author: Claude (sole author). This is an author report only. **No self-acceptance**; independent acceptance belongs to a separate invocation.

Snapshot: fa5a8ab6a329f029b3921f7b7df3695c9376e2d9 (source ZIP 51a59e46…727dc, manifest f19bef38…ca2d6, 821 files). Not Git ancestry.

## Changed paths (all within the write allowlist)
- `src/lib/paid-order-handoff-route.ts` — added exported `projectOutcome(action, lane, event, delivery)`; non-list commands now return it instead of the raw `{ event, delivery }`.
- `tests/paid-order-handoff-secrecy.test.ts` — new regression test (written first).
- `AUTHOR-REPORT.md` — this file.

Not modified: `src/lib/paid-order-outbox.ts` (outbox state machine), `tests/paid-order-outbox.test.ts` (existing guard tests), and anything else.

## Behaviour
- Response `event` holds only safe metadata: `id, kind, version, at, revenue`. The whole-event `owner`/`agent` delivery internals are never serialized.
- Response `delivery` holds only the requested lane: `lane, status, attempts, worker, expiresAt, receipt, recoveries` (recoveries is a count, not the receipt list).
- `token`/`workToken` appear only when `action === 'claim'` and the resulting status is `leased` or `ambiguous`, meaning a usable lease. They are left out on a `dead_letter` claim and on `ack`, `ambiguous`, `renew`, `recover_accepted_run` and `list`.
- `list` is unchanged (it was already redacted). Auth, origin, default-off, body-size and command validation and the 409 failure path are unchanged. Durable order and event contents are still written by `mutateOutbox` exactly as before. Projection affects only the response.
- Consumer-shape compatibility: the top-level `{ event, delivery }` shape stays, and `event.id/kind/version` are still present. **Breaking for any HTTP consumer that read `event.owner`/`event.agent`, or tokens from non-claim responses.** None was found in the three files read. A repo-wide consumer audit was not performed.

## TDD evidence (wrapper `run-tests.py`, network-denied sandbox)
- RED (before source edit): exit 1. 3 secrecy tests failed on leakage assertions (`response leaked OPP-agent-TOKEN-x9`, `OPP-owner-TOKEN-x9`, `OWNER-TOKEN-r7`), not module errors. 18 passed. Test sha256 37b69930…7ad1b1, source sha256 8eff2ec9…e1f092.
- GREEN (after edit): exit 0, 21/21 pass, including all 17 existing outbox tests. Same test sha256. Source sha256 42472d12…903fe6.

## Test coverage (new file)
- Both lanes (owner→agent and agent→owner): the opposite lane is preloaded with token, workToken, receipt and worker secrets. The serialized claim, renew, ambiguous, ack and list responses must not contain them. Claim tokens are present and equal the stored durable tokens. Non-claim responses contain neither their own tokens nor any `"token"`/`"workToken"` field. Afterwards the durable own-lane token and workToken are retained and the opposite lane is deep-equal to its preload, so fences were not erased.
- `recover_accepted_run` via the route: no agent or owner token/workToken in the response. The stored token is retained and `validWorkFence` still holds.
- Failure paths: a stale ack and a busy claim return 409 without secrets and leave the order unmutated. Default-off returns 409 and unauthenticated returns 401, with `transact` never invoked.
- Uses the real `handoffRequest` and `mutateOutbox` with a synthetic in-memory `transact` only. No DB, real orders, providers, transports or network.

## Residual gates / not done (subsequent work)
- Synthetic store, bounded explicit enrolled-ID worker, fake transports, scoped credentials, recovery and admin authorization, analytics: not started.
- No repo-wide audit of HTTP consumers of the old response shape.
- Typecheck (`tsc`) was not run. Only the specified wrapper was executed, and node strip-types does not type-check.
- No commit, push, deploy or graph update (the graph is the controller's responsibility after freeze).
- No tool denials occurred.
