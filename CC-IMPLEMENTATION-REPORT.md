# CC-IMPLEMENTATION-REPORT — HSB Upload State Machine V2 (foundation remediation)

**Date:** 2026-09-02
**Status:** R14 REMEDIATION CANDIDATE — uncommitted, unwired, inert; pending fresh exact-byte review.

## 0. Supersession and Rex remediation

Both earlier candidates are rejected and must not be used:

- 22 files: `29962ad158653e00a8b021bd46e3d559f1331d71600a69db6ecc726a1bde32fb`
- 32 files: `a2c40c2a43997a30914edecc74052a724cfbb927ad7a4e4795f82a51a7a911d3`
- 36 files (R10 review BLOCK): `db30edf43fe4d211faf70b96b219b2de19acbce4a19150ecd97421911a07ff51`
- Manual CC ZIP (stale; do not submit): `267360894152046035382ab7b33cac5137cbdda0e3ad8dfbf1ff4a1160c71a90`
- R11 ledger (BLOCK): `36e65a7c66fd088af910769edd76633246bb65cc62779f46672c4a676e857283`
- R11 manual CC ZIP (stale; do not submit): `fdee4fc37eb7d122ecd05a62c82048201f2a5798fe27eac4442c25195a048342`
- R12 ledger (BLOCK): `d0fcfcd5e153fab71bea16ad1598f246d85d4f9bb7d205063cb56279edabae04`
- R12 manual CC ZIP (stale; do not submit): `c367bd9a8e433d7e979ee3d5473dec3cb6cd5b054f64fc814a467045e9c14e0e`
- R13 ledger (Fable BLOCK): `01fd15d241bd8161276061ba0856271859cb4772fcc47a7d3b976f900476cb68`
- R13 manual CC ZIP (stale; do not submit): `fb961bb07c1e3a964e15421494aa623a3b6d7f1c5cc025c9791a46ce9b7b374f`

Alexy explicitly reassigned sole-writer remediation from Claude Code to Rex after
Claude capacity was unavailable. Rex added RED regressions for every reproduced
blocker, implemented the bounded fixes, and ran the real gates. No commit, push,
PR, Preview, environment change, Stripe call, customer mutation, or production
effect occurred.

| | |
|---|---|
| Worktree | `/Users/abigailclaw/cc-worktrees/hsb-checkout-upload-state-machine-v2-20260902` |
| Branch | `cc/hsb-checkout-upload-state-machine-v2-20260902` |
| Base / HEAD | `d7237ce0cb5cdbd42c657f1ccee7a584a2981a23` — **0 commits ahead** |
| Candidate manifest | Freeze externally after this report; reviewers must recompute exact bytes at entry and exit. |
| Focused R14 command | `node --experimental-strip-types --test tests/checkout-intake-order-cleanup-fence.test.ts tests/checkout-intake-order-binding.test.ts tests/checkout-intake-cleanup-retention.test.ts tests/checkout-intake-cleanup.test.ts` |
| Focused R14 result | **66/66 PASS** |
| Full suite | **2119/2119 PASS** |
| Production build | **PASS** — compile, TypeScript, page data, 24/24 static pages |
| `git diff --check` | **PASS** |
| Graphify | Updated: **2457 nodes / 4869 edges / 169 communities** |

The R3 review held the candidate on six reproduced blockers. R4 then held it on
four more: unresolved expired finalization allowed new reservations, parser-side
category caps were missing, lookup and embedded intake identities could diverge,
and retained tombstones had no terminal deletion lifecycle. R5 added duplicate
family-identity rejection, record-level timestamp ordering, monotonic writes,
and 30-day fail-closed authoritative order reconciliation for abandoned
finalizations. R6 adds monotonic nested lifecycle evidence, voice-consent
binding, exact guard compensation after a failed reservation CAS, and
capacity-safe removal at the superseded audit bound. R7 adds immutable
voice-consent timestamp/source provenance to reservations,
assets, finalized tuples, and fingerprints; occupied voice media cannot be
retroactively relabeled. R7 also makes the second reservation guard spend
explicitly cost zero request units and refunds only the scarce spend on CAS
failure. R8 adds production-path guard-store identity for spend/refund,
monotonic server-stamped consent chronology with strict parser bounds, and
token-bound provenance for stale callback audit assets. The current bytes
add canonical/bounded durable identities and exact required fields, global
asset/path/reservation uniqueness, exact finalization selection keys, a single
token issuance instant, lookup identity binding, parser-side category bounds,
unresolved-finalization upload fencing, and CAS-fenced terminal tombstones with
bounded deletion retention. Each blocker was captured RED before its minimal fix;
the exact focused 165-test and full 2068-test gates
above are historical post-fix runs.

R9 canonicalized server-stamped general-media consent and strict upload-token and
selection provenance parsing. R10 adds the pre-Stripe prepared-order saga with
create-if-absent persistence, recomputed immutable order-contract evidence, and
recursive capability rejection. Finalized unpaid media now has a 30-day,
order-CAS-fenced reclamation path shared with checkout lease renewal, takeover,
Stripe-session binding, and settlement writers. Paid, refunded, active-lease,
session-bound pending, mismatched, absent, and unknown order states retain media;
failed-payment orders become reclaimable only after the bound. Durable order reads
strictly validate the intake tuple, projections, fingerprint, exact keys, and
retention chronology. The R10 evidence was the 52-test focused gate and
2105-test full-suite gate.

R11 added exact serialized-byte intake validation, writer-side recomputation of
immutable order-contract evidence, and production-path/fingerprint round-trip
fixtures. Its independent review still BLOCKED on raw capability-value leakage
under innocent nested keys and handpicked rather than whole-record pre-Stripe
reconciliation. R12 reproduced both findings RED and fixed whole-order pre-Stripe
comparison, but its capability scan remained partial: prefixed string values and
opaque dynamic property keys could still persist the raw token. R13 reproduces
those bypasses RED with a realistic base64url capability. The service now rejects
capability-like keys, token substrings in values, and token substrings in keys,
and scans the actual prepared record handed to persistence. Ambiguous create
reconciliation JSON-normalizes the whole order and accepts differences only in
`updatedAt`, `checkoutLeaseId`, and `checkoutLeaseExpiresAt`; shipping,
fulfillment, artifact, refund, payment, retention, and all other state must remain
exact. Fable's R13 review then found that a boxed `String` is an object during
recursive traversal but serializes as the complete raw token. R14 reproduced the
durable-byte leak RED and now scans `JSON.stringify(value)` before traversal, so
boxed strings fail before persistence. Draft and requested-selection capability
checks now run before finalization, so contaminated input consumes no reservation;
the finalization result and fully prepared durable order bytes are scanned again
before persistence. R14 also closes the accepted pre-wiring robustness finding:
malformed finalization output (including invalid `reservedAt`) is contained as
structured `preparation_failed`, and the owning reservation abort is attempted
before returning.

Fable's second HIGH finding was also reproduced RED: an exact durable order plus
a failed `markIntakeFinalized` left `finalizedOrderId` null, causing cleanup to
preserve its media forever. The boolean existence dependency could not distinguish
that exact saga order from a foreign conflict. Cleanup now requires authoritative
four-state reconciliation (`exact`, `absent`, `conflict`, or `unknown`). Only an
exact order whose strict authoritative read matches order ID, intake ID, checkout
attempt, finalization fingerprint, and active retention state may be promoted to
`finalizedOrderId`; it then enters the existing order-side 30-day CAS claim and
reclamation path in the same run. `conflict` and `unknown` preserve media;
authoritative `absent` alone may clear the stale finalization. The abandonment
clock derives from immutable `finalization.reservedAt`, not reconciliation time.

The reviewer-identified test gaps are now load-bearing: the prepared-record scan,
exact mark-pending reconciliation, active-retention predicate, unknown/conflict
preservation past 30 days, claim-versus-session-binding CAS, and email membership
in the immutable order-contract digest each fail under their corresponding
single-point mutation. The explicit empty-capability line remains redundant by
construction because every serialized string includes the empty substring; empty
capability behavior is nevertheless regression-tested and fails closed. Current
evidence is the R14 66-test focused gate, 2119-test full suite, and production
build in the table.

All per-file F1–F8 test counts below are historical remediation notes, not
current evidence. Only the exact R14 command/result in the table above is the current
focused-suite claim.

The checksum table below documents the superseded Claude candidate only. It is
historical provenance, **not** the current review manifest. `vercel.json` remains
at base; `src/lib/orders.ts` remains the sole tracked modification inherited
from the bounded foundation.

### Manifest

| SHA-256 | Path |
|---|---|
| `9bfa89aaab4ed098e5f6a933d3d7150abe0948db19aec605ed15a00a5cc05395` | `src/app/api/checkout/intake/route.ts` |
| `0c6c3f637aff5f3cbe2bed3b8351f63bf558bc2555b15b9ebbfc37e4261376b0` | `src/app/api/checkout/intake/upload/route.ts` |
| `d924aa3add600889e475fb736971ab14fb304f6cd1e7f642e986af4ff1f32b6f` | `src/app/api/cron/checkout-intake-cleanup/route.ts` |
| `44821f20afe3dcd1ee3aaaa4c0801dc97f8bff1543daf603e78099a33bf40ad2` | `src/lib/blob-namespace.ts` |
| `d741864c2919e4d41dad97218920111bc2e1981088d6b1d07077db930b5c03ee` | `src/lib/checkout-blob-identity.ts` |
| `e47b8971453bd6262e7e273a89f18241a24b6c50bd7be17c7dfa240be9f1fc86` | `src/lib/checkout-direct-flags.ts` |
| `db93e87d6b470a3c80ad39213df95939b156aabc5b89722d6b15d44659c536a0` | `src/lib/checkout-finalize.ts` |
| `560a75601fc2d83265d112c3d76e6d5d0856f5a72d0185b1b169a29571a56d0d` | `src/lib/checkout-intake-cleanup.ts` |
| `9c9644e279ed4f2ed28390c222356796eba2de2a3f7361c34ff6233eddc12a99` | `src/lib/checkout-intake-client.ts` |
| `f42ea3f6db06f552a6db34d1ef99da8730a633f3e68057f1508d6268614a876c` | `src/lib/checkout-intake-route.ts` |
| `8d8e7dd2cc7588e3e628a6fb8ae5a470d59db0eaaf7fa167f5ff751a266dffb7` | `src/lib/checkout-intake-upload-route.ts` |
| `69b2f8603f7b77c1029fcb754a2f90aaa6c8a88684a21153c330dc75db177ad1` | `src/lib/checkout-intake-upload.ts` |
| `c9c113fdf36a775970b8b4d9e04789f239a1d6bcf1939854e18749018f1b80f6` | `src/lib/checkout-intake.ts` |
| `5690465b5eea61608b744c1872427be6528d4b5275ad9024afbf6db04bd7c022` | `src/lib/checkout-request-guard.ts` |
| `0ef2d80bda974f59709fa0bfb2168085ccb6e60099e127d4d771d88a42c5c4ea` | `src/lib/orders.ts` |
| `8421efb7b0d408027fed7a47f49eb82dc7d90fb07acc7578088db7a881a13a51` | `tests/checkout-finalize-atomic.test.ts` |
| `e4c97c2f0ab8dd03ea7c3400b8b834457eae18e144495d569f929ebd32e96f3c` | `tests/checkout-finalize-selection.test.ts` |
| `96a9951ef4f45b4915f50c1d9bc121feefe6fca20e0af70da961229c7f4f7f4b` | `tests/checkout-guard-config.test.ts` |
| `e20f51e4e7db851ef2d913c7ff0a33abdf986168cb7be4d5cccf4581bca7be34` | `tests/checkout-intake-budget.test.ts` |
| `a98bd7f0863305ecb7ffc77eeb0591a7d8c644eccb75cd4acdd2e5e3c068a41a` | `tests/checkout-intake-callback-auth.test.ts` |
| `04fa104b2b25610cbd8b7f24e07ee14765f73adf593ddaeb1c96a9df30edf1de` | `tests/checkout-intake-cleanup-retention.test.ts` |
| `352735b2e5659de70a227f027cd96b3df09d360ed0a96552973a0d5dac0cceaf` | `tests/checkout-intake-cleanup.test.ts` |
| `7ffe802b535ae0174e6ac21c4b0156faa468afea2b3fb2ff67a00bde96f128e7` | `tests/checkout-intake-client-fencing.test.ts` |
| `e15626812b1d5ac3d9302642d99325257b5c0637a077f1d73b78ff2cbcaabdfe` | `tests/checkout-intake-namespace-isolation.test.ts` |
| `9b5ce5e7f228b185fbb937942d14f63cb92bfe44cac4fd5cab6524f3d36af370` | `tests/checkout-intake-record-schema.test.ts` |
| `b37f391a3990b6a4deb194df86cc930f224ab68638805c1891cc0d08376302d9` | `tests/checkout-intake-route-shells.test.ts` |
| `247687416e61474cdf5871747638d82dfeef776561e749842d850d0ecaaa7270` | `tests/checkout-intake-route.test.ts` |
| `ae7eb0a02d322652d7b25e098b826941883780b0fd295f9f173af0c95a77e4af` | `tests/checkout-intake-schema-cardinality.test.ts` |
| `359a6ed0e5c6635fa9eec2cf99b56062b5c1120defd3ffa2a88b19a6198055c5` | `tests/checkout-intake-slot-generation.test.ts` |
| `b997d16751b1c938f61fcb7446b6798831a7378032fd57c350817923a35cdcd8` | `tests/checkout-intake-upload-route.test.ts` |
| `3163d5b393132e9f6d52b746f438726e62bfca7abad03f44bb8ebdeefcba9eac` | `tests/checkout-request-guard.test.ts` |
| `65652b2ce2285922f76f109f3e486d6348d656dad91c54e98722620a385b3976` | `tests/support/checkout-intake-memory-store.ts` |

The table above is the **historical 32-file Claude candidate ledger** for
`a2c40c2a…`. It is retained only to explain provenance. It is not a reproduction
recipe, current manifest, or review authority. The current candidate includes
this report and is always frozen externally with the complete modified+untracked
path set after the report's final byte is written.

---

## 1. Correction to the previous report

The previous report claimed **`npm run lint` — exit 0**. That was **wrong, and
it was my error**: I read the exit code of a shell wrapper (`npm run lint > log;
echo $?; tail log`) whose final command was `tail`, not the exit code of
`eslint`. I never opened the log.

The truth, verified this session:

- In this worktree `npm run lint` exits **127** — `sh: eslint: command not
  found`. `eslint` is referenced by the `lint` script but is **not a declared
  dependency** and is not in `node_modules/.bin`.
- The independent reviewer, resolving ESLint 10.8.0 from elsewhere, saw exit
  **2** — no `eslint.config.js/mjs/cjs` in the repo.

Both are failures. **Lint does not pass at base and does not pass here.** No
lint infrastructure was added, per the scope lock. This is a pre-existing
tooling gap, listed under remaining items as R-L.

The slot/generation architecture and the other disclosures in the previous
report stood up to review and are retained.

---

## 2. F1–F8 — RED then GREEN

Each item names the behavioural regression written first, the reproduced RED
output, and the GREEN result. Where the API under test did not exist yet, a
**naive composition mirroring what a caller would have to write** was added
first, so RED reproduces the real defect rather than a missing module.

### F1 — One atomic finalization operation

Naive composition added first (`validateFinalizeSelection` → caller fingerprint
→ `reserveIntakeFinalization`, exactly what the split API forced), then
`tests/checkout-finalize-atomic.test.ts`.

**RED — 9 of 11 failed:**

```
✖ a replacement landing mid-finalization makes the finalization fail
✖ finalization is refused while any slot has a pending replacement
✖ a pending upload in an UNSELECTED slot also blocks finalization
✖ the same media in a different family order is a DIFFERENT finalization
✖ the exact selected media tuple is persisted, not just a fingerprint
✖ the same attempt and the same selection is idempotent
✖ an expired finalization lease can be taken over, and only once
✖ an abandoned finalization can be explicitly aborted before its lease expires
✖ a finalized intake is closed to further finalization and further uploads
ℹ tests 11  ℹ pass 2  ℹ fail 9
```

**GREEN — `ℹ tests 11 / ℹ pass 11 / ℹ fail 0`.**

Required probes, all present and passing:

1. *validate A → replace with B → reserve using A* — `a replacement landing
   mid-finalization makes the finalization fail`. The replacement is injected
   between the read and the CAS; the result is `intake_finalization_conflict`
   and the record carries **no** finalization.
2. *active A retained while replacement B pending* — `finalization is refused
   while any slot has a pending replacement` → `intake_replacement_pending`.
   Extended to unselected slots too.
3. *`[alice,bob]` vs `[bob,alice]`* — `the same media in a different family
   order is a DIFFERENT finalization`. Fingerprints differ; persisted indexes
   are 0/1 and 1/0.
4. *crashed lease* — `an expired finalization lease can be taken over, and only
   once`. While the lease is live a second attempt conflicts; after it expires
   the takeover succeeds; the abandoned attempt's `markIntakeFinalized` is then
   refused with `intake_finalization_not_reserved` while the taker's succeeds.

What changed: `finalizeIntakeSelection` reads the record **once**, validates
everything against that version, and compare-and-swaps against that exact etag —
a CAS failure is a conflict, never a retry against a newer record. The
standalone `reserveIntakeFinalization` export is **gone**; the fingerprint is
computed inside from the resolved tuple over slot, category, stable family id,
**derived index**, guided index, asset id, pathname, MIME, size, etag and
generation; the tuple itself is persisted in `finalization.selection`; and the
reservation carries a 15-minute lease with `abortIntakeFinalization` as its
explicit counterpart.

### F2 — Fail-closed canonical durable schema and cardinality

`tests/checkout-intake-schema-cardinality.test.ts`.

**RED — 13 of 14 failed**, including the exact reproduced probes:

```
✖ a slot whose category disagrees with its key is refused
✖ a slot carrying reference fields its key does not imply is refused
✖ unknown keys are refused rather than ignored
✖ 100 reserve/release cycles cannot retain 100 slots
✖ 100 reserve/release cycles on ONE slot cannot produce unbounded generations
✖ total churn across all slots is bounded, not just per slot
✖ an oversized stored record is refused before it is fully buffered
ℹ tests 14  ℹ pass 1  ℹ fail 13
```

**GREEN — `ℹ tests 14 / ℹ pass 14 / ℹ fail 0`**, plus the retained
`checkout-intake-record-schema` suite at `11/11`.

`parseIntakeRecord` now refuses unknown keys at every level, proves each slot
key is exactly what `slotKeyFor` derives AND that fields the category does not
use are null (which is what caught `primary_hero_photo` carrying
`category: voice_inspiration` and `guidedStillIndex: 99`), checks each
asset/reservation against its slot's identity and generation, requires the
pathname to equal the derived path, enforces the category MIME and size policy,
validates superseded reason enums and `supersededAt >= completedAt`, and
validates cleanup/finalization timestamp ordering.

Churn is bounded by **generations**, not by the superseded list — an abandoned
reservation never completes and an empty family tombstone is neither occupied
nor superseded, which is why the old `INTAKE_MAX_SUPERSEDED=64` statement
bounded nothing:

| Bound | Value |
|---|---|
| `INTAKE_MAX_SLOTS` (incl. tombstones) | 24 |
| `INTAKE_MAX_SLOT_GENERATION` | 20 |
| `INTAKE_MAX_TOTAL_GENERATIONS` | 60 |
| `INTAKE_MAX_SUPERSEDED` | 32 |
| `INTAKE_MAX_RECORD_BYTES` | 262144 |

`readJsonTextWithLimit` stops and cancels the stream at the byte cap instead of
buffering whatever the store returns. Removal never refuses on churn grounds —
a buyer must always be able to take a photo back out — so it stops bumping the
generation at the ceiling; fencing is preserved because clearing `pending`
alone already makes a late callback stale.

### F3 — Real byte-budget enforcement, exactly once

`tests/checkout-intake-budget.test.ts`.

**RED — 4 of 4 failed**, reproducing the probe exactly:

```
✖ a 15 MiB reservation charges 15 MiB to the durable bucket
  AssertionError: the declared size must reach the durable counter
    actual: 0,  expected: 15728640
✖ crossing the byte ceiling refuses BEFORE the reservation is written
    actual: 200, expected: 429
ℹ tests 4  ℹ pass 0  ℹ fail 4
```

**GREEN — `ℹ tests 4 / ℹ pass 4 / ℹ fail 0`.**

**Ruling implemented and documented in `checkout-intake-route.ts`:** bytes are
charged **once, at `reserve-upload`, against the declared reserved size**,
because a reservation authorises an upload of that size whether or not the
bytes arrive — so an abandoned reservation is charged (asserted by `an
abandoned reservation still costs its declared bytes`).
`uploadReservations`, `uploadBytes` and `replacementCount` are all charged at
that one point, from a size validated before the spend so a refused spend
leaves no reservation behind. Token issuance charges `requestCount` only;
callback completion charges its own request and never re-charges bytes.

### F4 — Cleanup/finalization correctness and bounded retention

`tests/checkout-intake-cleanup-retention.test.ts`.

**RED — 5 of 6 failed**, including the required probe verbatim:

```
✖ an upload landing after the initial scan does not orphan bytes or poison the next run
  AssertionError: no object may be left without a record
    actual: [ 'intakes/intake_…/assets/asset_…' ],  expected: []
✖ a finalized order keeps exactly its selected media and reclaims the rest
✖ a crashed finalization stops fencing cleanup once its lease expires
✖ a partial deletion failure keeps the record and is reported
✖ a failed claim release is surfaced rather than swallowed
ℹ tests 6  ℹ pass 1  ℹ fail 5
```

**GREEN — `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`**, plus the retained
`checkout-intake-cleanup` suite at `9/9`.

The global prefix scan is only an enumeration of intakes plus the explicability
check. The **claim is taken first**, then the record is re-read under it and the
intake's own prefix is **re-listed** to build the authoritative plan. After asset
deletion, cleanup re-lists again (up to 3 passes). When nothing remains it CAS-
writes a compact terminal tombstone; that immutable tombstone is not reclaimed
or rewritten on subsequent sweeps and its record is deleted after 24 hours. A
refused delete is counted (`deleteFailures`) and keeps the record so the object
stays explained. A failed claim-release CAS is counted
(`claimReleaseFailures`) instead of being ignored. Any unresolved finalization,
expired or not, fences uploads and cleanup. After 30 days past lease expiry,
cleanup consults `getOrderAuthoritative`: an existing order or any lookup
uncertainty preserves media; only authoritative absence permits CAS-clearing the
reservation and entering the normal claimed cleanup lifecycle.

Retention rule, now exact and explicit: a **finalized** intake keeps only the
objects in `finalization.selection` and its record; every other object it holds
is reclaimed (`retainedFinalized`). Previously a finalized intake was skipped
forever, so unselected private media was kept indefinitely.

### F5 — Namespace and Blob-store identity isolation

`tests/checkout-intake-namespace-isolation.test.ts`.

**RED — 4 of 9 failed:**

```
✖ every intake and guard path is namespaced
    actual: 'intakes/intake_….json',  expected: 'preview/intakes/intake_….json'
✖ the intake credential is refused when it shares a store with orders or the guard
    AssertionError: Missing expected exception
✖ Preview without an explicit namespace fails closed
✖ Preview naming itself "production" is refused
ℹ tests 9  ℹ pass 5  ℹ fail 4
```

**GREEN — `ℹ tests 9 / ℹ pass 9 / ℹ fail 0`.**

The repository's own primitive is used, not a second copy: `getBlobNamespace` /
`withBlobNamespace` / `BlobNamespaceError` were **moved** from `orders.ts` to
`src/lib/blob-namespace.ts` (parameterised on `env`, defaulting to
`process.env`) and are **re-exported from `orders.ts` unchanged**, so all
existing importers are untouched. That move was the complete `orders.ts` change
for the F5 namespace extraction only; later R10–R13 work adds separate durable
intake binding, digest, retention, and writer changes in the same file.

Every intake and guard record/list/delete path is namespaced, and the namespace
is resolved **once at store construction**, so a Preview deployment without
`HSB_BLOB_NAMESPACE` cannot come into existence pointing at production keys.
Store identity is compared by **parsed Blob store id** (`vercel_blob_rw_<storeId>_<secret>`,
the same split the SDK uses), so two different credentials for one store are
refused; token shape is validated and no error message, return value or log line
ever contains token bytes.

### F6 — Authenticate callback before callback-budget spend

`tests/checkout-intake-callback-auth.test.ts`, driving the **real**
`@vercel/blob/client` `handleUpload` with a real `x-vercel-signature`
(`HMAC-SHA256(token, JSON.stringify(body))`). Both SDK branches are local
crypto; nothing here touches the network.

**RED — 3 of 6 failed:**

```
✖ a callback with NO signature spends no budget and touches no intake state
  AssertionError: no callback budget was consumed
    actual: { scope: 'intake-upload-callback', …, requestCount: 1, … },  expected: null
✖ a callback with a WRONG signature spends no budget and touches no intake state
✖ authentic callbacks are still bounded
ℹ tests 6  ℹ pass 3  ℹ fail 3
```

**GREEN — `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`.**

The callback branch now spends **nothing** at branch selection. Its budget is
consumed inside `onUploadCompleted`, which the SDK reaches only after verifying
the HMAC, and still before any intake or storage work. An unsigned or
mis-signed callback consumes **zero** budget and does **zero** intake-store work
(asserted by counting `read`/`headAsset`/`compareAndSwap`). Browser token
generation keeps its same-origin guard and its own pre-token budget.
`HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE` bounds authentic callbacks
separately from browser traffic.

### F7 — Fail-closed guard schema and configuration

`tests/checkout-guard-config.test.ts`.

**RED — 3 of 6 failed:**

```
✖ a guard bucket must carry a real updatedAt        (Missing expected exception)
✖ unknown fields in a guard bucket are refused, not dropped
✖ a malformed configured limit fails closed instead of defaulting
ℹ tests 6  ℹ pass 3  ℹ fail 3
```

**GREEN — `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`.**

`parseGuardBucket` requires a valid ISO `updatedAt` and refuses unknown fields.
`readConfiguredLimit` accepts unset/empty (documented default) or **plain
decimal digits only** — `'O'`, `'-1'`, `'1_000'`, `'12.5'`, `'unlimited'`,
`'NaN'` all raise `abuse_guard_config_invalid` (503) rather than silently
widening a limit someone was tightening. `Number()` would also have accepted
`'0x10'` and `'1e3'`. An explicit `'0'` is preserved as `0`.

### F8 — Route-shell and error semantics

`tests/checkout-intake-route-shells.test.ts`.

**RED:**

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/lib' imported from
  …/src/app/api/checkout/intake/route.ts
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

That is the finding itself: the shells used the `@/…` tsconfig alias and could
not be loaded by a test at all, so no shell coverage was possible. (The repo's
other testable route, `api/cron/fulfillment-sweep`, uses relative `.ts` imports
for exactly this reason.)

**GREEN — `ℹ tests 10 / ℹ pass 10 / ℹ fail 0`.**

All three shells now use relative `.ts` imports and are invoked directly:
intake and upload return 404 with the flag off and 503 with no dedicated store
or no Preview namespace; the cron shell returns 503 without `CRON_SECRET`, 401
on a wrong bearer, `{ok:true, skipped:'direct_upload_disabled'}` when
authorised but flag-off, and 503 when the store is unconfigured (a fail-closed
`IntakeError` status is no longer flattened to 500). The helper-boundary suites
are retained and are **not** counted as shell coverage.

`headAsset` now distinguishes absent from unreadable: a `BlobNotFoundError`
returns `null` (upload has not landed → `resolve-upload` reports `pending`),
and any other provider failure raises a retryable `intake_store_unavailable`
503. A narrow `io.head` seam on `createVercelIntakeStore` makes both paths
testable against the real store code.

---

## 3. Verification

Run in the required order. RED evidence per item is in §2.

| Command | Result |
|---|---|
| Focused: `checkout-intake-slot-generation` | 8 pass / 0 fail |
| Focused: `checkout-request-guard` | 14 / 0 |
| Focused: `checkout-intake-upload-route` | 10 / 0 |
| Focused: `checkout-intake-cleanup` | 9 / 0 |
| Focused: `checkout-finalize-selection` | 14 / 0 |
| Focused: `checkout-intake-client-fencing` | 9 / 0 |
| Focused: `checkout-intake-route` | 13 / 0 |
| Focused: `checkout-intake-record-schema` | 11 / 0 |
| Focused: `checkout-intake-namespace-isolation` (F5) | 9 / 0 |
| Focused: `checkout-intake-schema-cardinality` (F2) | 14 / 0 |
| Focused: `checkout-finalize-atomic` (F1) | 11 / 0 |
| Focused: `checkout-intake-budget` (F3) | 4 / 0 |
| Focused: `checkout-intake-callback-auth` (F6) | 6 / 0 |
| Focused: `checkout-guard-config` (F7) | 6 / 0 |
| Focused: `checkout-intake-cleanup-retention` (F4) | 6 / 0 |
| Focused: `checkout-intake-route-shells` (F8) | 10 / 0 |
| Historical `npm test` for `a2c40c2a…` | `2036 / 2036`, exit 0 — superseded evidence only |
| Historical build for `a2c40c2a…` | exit 0 — superseded evidence only |
| **`npm run lint`** | **exit 127 — `sh: eslint: command not found`. NOT A PASS.** See §1 |
| `git diff --check HEAD` | exit 0 — pass |
| Historical secret scan | 32/32 files, no credential material; superseded evidence only |
| Historical Graphify | `2412 nodes, 4719 edges, 172 communities`; superseded evidence only |
| Historical manifest | **REJECTED:** 32 files, `a2c40c2a43997a30914edecc74052a724cfbb927ad7a4e4795f82a51a7a911d3` |

The historical 16 focused suites contributed 154 tests. Those totals describe
only the rejected `a2c40c2a…` bytes and make no claim about the current candidate.

**The build failed once during this work** (a TypeScript error in
`abortIntakeFinalization`, where two branches returned different literal
`result` types that `mutateIntake`'s generic could not unify). It was fixed by
annotating the callback's return type; the exit-0 above is from the rebuild
after that fix.

---

## 4. Remaining items

**R1 — Not wired, by instruction.** `src/app/checkout/checkout-form.tsx` and
`src/app/api/order/route.ts` are untouched; nothing in product code imports the
intake, client, or finalization modules. **The Mobile Safari Private Browsing
failure is not fixed in the product.** This is a foundation, and it must not be
called the product fix until a real mobile checkout uploads directly and reaches
Stripe without multipart media.

**R2 — `vercel.json` restored to base.** Cron activation is a separately
approved release slice. `/api/cron/checkout-intake-cleanup` exists and is
tested, but is scheduled by nothing.

**R3 — Stripe success-URL PII, unfixed and out of scope.**
`src/app/api/order/route.ts:644-649` puts `childName` and `email` into
`successParams`, and `:684` into `success_url`. Held by the scope lock; still
open.

**R4 — Provider behaviour is proven for the callback, not end to end.** F6 uses
the real SDK and a real signature, so callback authenticity is genuine
evidence. Still unproven without a Preview deployment: the real client-token
round trip, actual callback delivery, multipart uploads (>4 MiB), real
`BlobPreconditionFailedError` on stale `ifMatch`/create races, and real
multi-page private listings. **Verification owed at Preview.**

**R5 — Blob token shape rule needs one Preview check.** `parseBlobToken`
requires `vercel_blob_rw_<storeId>_<secret>` with alphanumeric segments of at
least 8 characters each. That matches the SDK's own `split('_')[3]` derivation
and the tokens seen in this repo's configuration docs, but it has not been
checked against a live credential. If a real token has a different alphabet,
intake and guard will **fail closed** — safe, but it would block Preview until
the rule is widened.

**R6 — `del()` still has no provider precondition.** `@vercel/blob` 2.3.3
exposes `ifMatch` on `put` only. The claim plus the re-list-before-record-delete
is the fence; a conditional delete is not available in the installed SDK.

**R7 — Environment variables required, none set.** Nothing was read for its
value or changed. To enable: `HSB_CHECKOUT_DIRECT_UPLOAD=true`,
`NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD=true` (only meaningful after wiring),
`HSB_INTAKE_BLOB_READ_WRITE_TOKEN` and
`HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN` (**three distinct Blob stores** with
`BLOB_READ_WRITE_TOKEN` — same-store credentials are now refused),
`HSB_CHECKOUT_GUARD_MODE=durable`, and `HSB_BLOB_NAMESPACE` on Preview.

**R8 — Churn bounds are fixed constants**, not configurable and not tuned
against real behaviour. A buyer who swaps family characters more than ~24 times
in one intake, or replaces one photo more than 10 times, is refused with a 429.
The numbers are in §2/F2 and are a judgement call worth a ruling.

**R9 — Client fencing is still pure reducers.** No component or fetch-level test
shows reordered real promises cannot repaint stale state, because no component
consumes the reducers yet. Owed when wiring lands.

**R10 — Uploaded bytes get declared MIME/size checks only.** Before provider,
proof or customer use, wiring must privately fetch the bound object and apply
format-specific validation (full image decode with dimension/frame bounds,
metadata stripping and canonical re-encode; bounded document/audio parsing) with
no public/bearer URL downgrade.

**R-L — Lint is broken at base.** `eslint` is invoked by the `lint` script but
is not a declared dependency, and the repo has no ESLint flat config. Not fixed
here (scope lock explicitly forbids adding lint infrastructure without separate
authorisation). Recommend a separate narrow slice.

---

## 5. Zero-external-effects attestation

For the duration of this remediation, in this worktree:

- **No commit, push, branch publication, PR, Preview, or deploy.** Branch is at
  `d7237ce…` with **0 commits ahead**; the entire candidate is uncommitted
  working-tree state.
- **No environment variable read for its value, set, or changed.** Route-shell
  tests set and restore `process.env` keys **in process only**; no `.env` file
  was created, read or modified.
- **No live Stripe, Vercel Blob, Lulu, OpenAI/Gemini/fal, email, or webhook
  call.** All tests run against in-memory doubles; the one place the real
  `@vercel/blob/client` SDK is exercised (F6) uses only its local HMAC
  verification path.
- **No customer, order, payment, refund, print or email state touched.** No
  admin endpoint invoked.
- **No public post; no project content sent to any external service.**
- `cc-worktrees/hsb-checkout-direct-private-blob-pr1-20260901` (preserved
  rejected worktree) was **not opened for write** and is unchanged.
  `cc-worktrees/hsb-checkout-recovery-simplification-20260901` was **not opened
  at all**.
- `vercel.json` is byte-identical to base; the cron hunk was reverted with
  `git checkout --`.
- Writes outside this worktree: none, beyond the session scratchpad copy of the
  supplied ZIP. `graphify-out/` was regenerated inside this worktree only
  (AST-only, no API cost, git-ignored).

Everything is left **uncommitted** for a fresh exact-byte independent review.

**Worktree:** `/Users/abigailclaw/cc-worktrees/hsb-checkout-upload-state-machine-v2-20260902`
**Current manifest:** intentionally external. Recompute only after this report,
tests, build, and Graphify output are final; any later edit invalidates it.
