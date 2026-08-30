# Family Review runtime Blob credential — the private lane gets its own store

- **Prepared:** 2026-08-27
- **Base:** `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` (`origin/main`; PR #157 + PR #160)
- **Unblocks:** the BLOCKER in `docs/reviews/hsb-private-blob-rebound-20260827.md` §4 (draft PR #161, head `b37798c`)
- **Scope:** code, tests, and documentation. No configuration, deployment, migration, store provisioning, or live-data access.

---

## 1. What was wrong

`BLOB_READ_WRITE_TOKEN` is not the Family Review lane's credential. It is the
whole application's:

| Prefix | Owner | Copied by the migration? |
|---|---|---|
| `family-review/submissions/…` | Family Review record | yes |
| `family-review/review-tokens/…` | Family Review token index | yes |
| `family-review/photos/…`, `family-review/samples/…` | Family Review bytes | yes |
| `orders/…` (records, customer photos, voice notes) | order lane | **no** |
| `payment-recovery/…` | payment recovery | **no** |
| `recovery/…` | order recovery | **no** |

A Vercel Blob token is scoped to one store, and a store is created public or
private and cannot be flipped — so the private Family Review lane is a
different store. Before this change, no runtime code read
`FAMILY_REVIEW_DEST_BLOB_TOKEN`; every Family Review call resolved its store
from the ambient token. That left exactly three possibilities, all bad:

1. Migrate but do not flip — the app keeps reading the untouched source
   records, so the public exposure the cutover exists to close stays open, and
   a second full copy of every child photo now exists.
2. Set `FAMILY_REVIEW_BLOB_ACCESS=private` alone — private writes go to the
   **public** store, which rejects them, and new parent-photo and admin-sample
   uploads start failing.
3. Repoint `BLOB_READ_WRITE_TOKEN` — closes the Family Review exposure and
   strands the order lane, payment recovery, and recovery in a store the app
   is no longer looking at.

## 2. The change

The Family Review lane addresses its store **explicitly** in private mode.
Everything else keeps using the ambient token, untouched.

`src/lib/family-review/blob-credentials.ts` (new) owns the credential:

- `FAMILY_REVIEW_PRIVATE_TOKEN_ENV` — `FAMILY_REVIEW_DEST_BLOB_TOKEN`.
  Deliberately the variable the migration already writes to: it names the
  migrated destination store, it is already one of the five approved cutover
  variables, and reusing it means the runtime and the migration cannot
  disagree about which store "the private Family Review store" is. **No sixth
  Production variable is introduced.**
- `blobStoreIdFromToken` — moved here from
  `scripts/family-review-migrate-assets.ts`, which now imports and re-exports
  it. One parser, so the runtime cannot accept a credential the migration
  refuses (or the reverse), and a Vercel format change fails both closed
  together.
- `familyReviewPrivateTokenProblem` / `familyReviewPrivateToken` — fail-closed
  resolution. A problem message
  names the variable and the fault and **never** the value.

### Every runtime call site

| Call | Module | Public mode | Private mode |
|---|---|---|---|
| `put` asset bytes | `private-assets.putAsset` | ambient | `token` (resolve-or-throw) |
| `get` asset bytes | `private-assets.openAsset` | legacy URL `fetch` | `token` (resolve-or-throw) |
| `del` asset | `private-assets.deleteAsset` | ambient | `token`, or refuse |
| `head` asset | `private-assets.statAsset` | ambient | `token`, or refuse |
| `put` record + token index | `store.persistSubmission` | ambient | `token`, or refuse |
| `list` submissions | `store.listRecentSubmissions` | ambient | `token`, or refuse |
| `get` record / index JSON | `store.getJsonAtPath` | ambient | `token` on the private attempt |

### Fail closed

- `hasBlobToken()` — the gate the upload and admin-sample routes already turn
  into `503 storage_disabled` — is now mode-aware. In private mode it requires
  the dedicated credential and **never** consults the ambient one. A missing,
  blank, or malformed credential closes the door before any SDK or network
  call, with the same honest response an unconfigured deployment already
  returns, and logs a message naming the variable and the fault.
- `putAsset` / `openAsset` throw `AssetStorageError('credential_unavailable')`
  rather than writing to, or reading from, the order lane's store.
- `deleteAsset` reports `{ deleted: false, reason: 'credential_unavailable' }`
  rather than issuing a `del` against the ambient store — which would delete
  nothing here and could delete something there.
- `getJsonAtPath` resolves the credential **before** it builds its attempt
  list, so an unusable credential cannot fall through to the public attempt.

### What did not change

Public mode. Byte-for-byte the same calls, with no token option, against the
same store — which is what the apex and every current Production deployment
run. No runtime module outside `src/lib/family-review/` was touched:
`orders.ts`,
`payment-recovery.ts`, `recovery.ts`, `fulfillment.ts`, checkout, and the
provider lanes are untouched, and PR #160's checkout hand-off shares no file
with any of this.

## 3. The one remaining public touch, and how an operator closes it

In private mode, a **record-JSON** read that misses may fall back once to a
public read, so a deployment can still read records written before the
migration. This is PR #157's `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS`
path (§9 of that doc), retained deliberately rather than removed:

- it applies to record and token-index JSON only — asset **bytes** never fall
  back, and a private byte read that fails throws;
- the fallback attempt carries **no** token, so it addresses the ambient
  public store rather than the private one;
- it is unreachable when the credential itself is unusable — that is a stop,
  not a fallback;
- setting `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS=0` removes it
  entirely, and the isolation suite proves the lane then touches the ambient
  store **zero** times.

Removing it outright was rejected as out of scope: it is merged, reviewed
behavior, and deleting it would lock out any family whose record had not yet
migrated. The Gate B runbook should set the flag off once migration reports
zero failures.

## 4. Test evidence

New: `tests/family-review-runtime-blob-credential.test.ts` (15) and
`tests/family-review-two-store-isolation.test.ts` (19), plus the harness under
`tests/helpers/`.

The isolation harness runs each scenario in a **child process** with
`@vercel/blob` resolved to a two-store fake that models the SDK's real store
resolution (explicit `token:` wins, otherwise the ambient variable). The real
`store.ts`, `private-assets.ts`, and `orders.ts` run unmodified — no injected
client, no seam added to production code for a test's benefit — and the fake
journals which store every call landed on. Synthetic data, fake credentials,
no network.

| Scenario | Proven |
|---|---|
| private, valid credential | every Family Review `put`/`get`/`list`/`del` lands on the destination store with an explicit token; records, token indexes, parent photos, and admin samples are one boundary |
| private, valid credential | `persistOrder` / `getOrder` stay on the ambient store; the private store holds no `orders/…` and the ambient store gains no new `family-review/…` |
| private, missing / blank / malformed credential | **zero** Family Review store calls; the 503 gate closes; writes and reads throw `credential_unavailable`; delete reports it; the order lane keeps working |
| public mode | ambient store, no token passed, `storage: 'public'` with a URL — unchanged |
| public mode, private-marked asset | refuses rather than inventing a public read |
| private, missing asset | throws `not_found`; asset bytes are never re-read publicly |
| private, legacy reads off | the ambient store is touched zero times |
| private, legacy reads on | the only public touch is a token-less record-JSON `get` |
| all scenarios | no token value in the child's stdout or stderr — logs, thrown messages, and the serialized journal all checked |

| Command | Result |
|---|---|
| `npm test` | **1818/1818 pass**, 0 fail (was 1784 on base) |
| `npm run build` | ✓ Compiled successfully |
| `npx playwright test` | **119/119 pass**, desktop + mobile |
| `npx playwright test tests/e2e/checkout-stripe-handoff*.spec.ts` | **9/9 pass** (PR #160 preserved) |
| `tests/family-review-{private-assets,asset-access-control,asset-migration,privacy,image-type}` | 12 / 17 / 103 / 33 / 6 — all pass |
| `npm run lint` | **not run** — `eslint` is not an installed dependency (`sh: eslint: command not found`). Pre-existing; §13 of the PR #157 doc records the same gap. Not changed: tooling is out of scope. |

## 5. What this does and does not unblock

**Does:** Gate B of `docs/runbooks/hsb-private-blob-cutover-20260827.md` is no
longer structurally impossible. The runtime flip becomes
`FAMILY_REVIEW_BLOB_ACCESS=private` plus a `FAMILY_REVIEW_DEST_BLOB_TOKEN`
that names the private store — both already inside the approved five
variables — with `BLOB_READ_WRITE_TOKEN` untouched.

**Does not:** Gate B is still gated on everything it was gated on before, and
on one thing more:

1. **This code must be independently reviewed and deployed first.** A Gate B
   approval must bind to a Production deployment that actually contains it.
2. Encrypted backup completion, verified by a separate receipt.
3. Gate A — private store provisioned, five variables set, dry-run exact,
   apply clean, every object live-byte verified.
4. The combined checkout + Family Review smoke in the runbook §B.1.
5. Apex/www promotion (Gate C) and legacy reclamation (Gate D) remain
   separate.

**Still unverified anywhere:** the two-store boundary has never been exercised
against a real Vercel Blob store. PR #157's Preview soak stopped before the
first destination write, and this change's evidence is a fake. The first real
exercise must be Preview, not Production.

## 6. Residual risks

1. **Fake, not a store.** The isolation harness models the SDK's token→store
   resolution; it does not prove Vercel behaves that way. It is a regression
   guard against re-opening the boundary in code, not evidence that the
   private store works.
2. **`getJsonAtPath`'s legacy public attempt** remains the one path by which a
   private-mode deployment touches the ambient store (§3). It is flag-closable
   and asset bytes are exempt, but it is a real exception to "private mode
   never reads publicly" and is called out rather than hidden.
3. **`statAsset` has no runtime caller** today. It was brought inside the
   boundary for consistency rather than left as a latent ambient-store call.
4. **Token format assumption** — `vercel_blob_rw_<storeId>_<secret>`. Shared
   now with the migration, so a format change fails both closed rather than
   one open.
5. **A mode flip with the wrong store in `FAMILY_REVIEW_DEST_BLOB_TOKEN`**
   would address a real but wrong store. The runtime deliberately does not
   re-verify the source/destination distinctness the migration enforces —
   there is no source token at runtime to compare against. Gate A's
   distinct-store proof remains the control.
6. **No lint** (§4).
