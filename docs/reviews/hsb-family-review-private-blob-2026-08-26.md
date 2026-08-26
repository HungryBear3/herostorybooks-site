# Family Review — private asset storage: audit, threat model, and migration design

Date: 2026-08-26
Base commit: `d6c5602` (`origin/main`)
Scope: `/family-review` (parent portal + admin board) asset lifecycle only.
Status: **candidate + design. No Preview or Production data, config, deploy, or customer action occurred.**

> Base-branch note. This work is cut from `origin/main`, not from the
> checked-out `fix/copy-chicago-not-california`, which diverged at PR #22
> and is 111 commits behind — it predates the Lane B privacy hardening
> (`e0f7cfd`, `0a1b321`) that this design builds on. Building there would
> have re-derived exposure `main` already closed.

---

## 1. Current exposure

### 1.1 What is stored, and how

`src/lib/family-review/store.ts` persists four object classes, all with
`access: 'public'`:

| Object | Pathname | Written by | Contents |
|---|---|---|---|
| Submission record | `{ns}/family-review/submissions/{submissionId}.json` | `persistSubmission` | parent name, parent email, child first name, age range, pronoun, consent, feedback free-text, status |
| Reference photo | `{ns}/family-review/photos/{submissionId}/{assetId}.{ext}` | `uploadPhotoBytes` | **photographs of a child** |
| Sample illustration | `{ns}/family-review/samples/{submissionId}/{assetId}.{ext}` | `uploadSampleBytes` | rendered artwork derived from that child |
| Review-token index | `{ns}/family-review/review-tokens/{sha256(token)}.json` | `persistSubmission` | `{ submissionId }` |

Namespace isolation (`withBlobNamespace`, `src/lib/orders.ts:1121`) keeps
Preview under a `preview/` prefix, so Preview cannot list or address
Production paths. That control is sound and is preserved.

### 1.2 What is already closed on `main`

The Lane B hardening did real work and this design keeps all of it:

- Raw review tokens are never persisted; storage addresses them by
  `sha256` only (`hashReviewToken`).
- Identifiers are real capabilities: 128-bit `submissionId`, ~192-bit
  `reviewToken`, ~96-bit `assetId`, none sortable or time-leaking.
- Original filenames never leave the parent's device.
- Both render paths already go through **app-origin proxies**, not raw
  Blob URLs: admin `…/asset/{assetId}` (cookie-gated, asset must belong
  to the submission) and parent `…/review/{token}/sample/{assetId}`
  (token-gated, 404-never-403 so it cannot enumerate).
- The parent server page and the parent GET API both redact `blobUrl`.
- `middleware.ts` applies `X-Robots-Tag`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, `Permissions-Policy`, a self-only CSP with
  `frame-ancestors 'none'`, and a `private, no-store` default.

### 1.3 Residual findings

The proxies are defense in depth over objects that are **still world-readable
to anyone holding the URL**. The URL is an unguessable bearer credential
with no expiry, no revocation, and no audit.

| # | Sev | Finding |
|---|---|---|
| F-1 | High | Child reference photos are `access:'public'` **and** `cacheControlMaxAge: 31536000`. Anyone with the URL reads the bytes unauthenticated; edge copies may outlive an origin delete by up to a year. |
| F-2 | High | The submission JSON — parent email, child first name, feedback text — is `access:'public'` at a deterministic pathname. |
| F-3 | High | `GET /api/family-review/submissions` returns **full** records including `photos.assets[].blobUrl` and `samples[].blobUrl`. Raw permanent bearer URLs for children's photos are delivered into the admin browser (history, devtools, extensions, screen shares) even though the board renders via the proxy. |
| F-4 | Med | `POST …/sample` echoes the full asset incl. `blobUrl` — same class as F-3. |
| F-5 | Med | `X-Content-Type-Options: nosniff` is set **nowhere** in the app. |
| F-6 | Med | The admin sample upload trusts client-declared `file.type` with no magic-byte check. The parent upload route *does* sniff — the admin path is the weaker one. |
| F-7 | Med | Legacy token indexes are addressed by the **raw review token in the pathname**, i.e. a public URL that contains a live parent capability. |
| F-8 | Med | `deleteBlob` swallows every error and returns `void`; admin `DELETE` reports `ok:true` regardless. Deletion is unverified, and there is no edge-cache purge for F-1. |
| F-9 | Low | Both proxies stream `upstream.body` with no size bound. |
| F-10 | Low | The parent proxy hardcodes a `.png` filename regardless of actual mime. |

### 1.4 The governing infrastructure constraint

`src/lib/orders.ts:776` records a previously observed hard fact:

> the prod token rejects `private` writes with
> `BlobError: Cannot use private access on a public store`

**The Production Blob store is provisioned as a public store.** No amount
of application code makes `access:'private'` succeed against it. Provisioning
a private-capable store is an infrastructure action outside this candidate's
authority. This is why the candidate is flag-gated and defaults to today's
behavior — see §7 and §12.

---

## 2. Proposed private Blob architecture

A single storage abstraction, `src/lib/family-review/private-assets.ts`,
becomes the only module in the Family Review lane that talks to
`@vercel/blob` for asset bytes. It exposes `putAsset`, `openAsset`,
`deleteAsset`, and `assetStorageMode`.

- **Writes.** New photo and sample bytes are written with the configured
  access mode. When that mode is `private`, the write is `access:'private'`
  and `cacheControlMaxAge: 0` — no year-long edge cache (F-1).
- **Server-only references.** `PhotoAsset` / `SampleAsset` gain
  `storage: 'public' | 'private'`. For private assets `blobUrl` is **not
  populated** — the durable reference is `blobPathname`, which is useless
  without the store token. `blobUrl` becomes optional and legacy-only.
- **Reads.** Private bytes are read with
  `get(pathname, { access: 'private', useCache: false })`, which sends the
  store token. Legacy public assets keep the existing `fetch(blobUrl)` path,
  reached **only** when `asset.storage !== 'private'` (§9).
- **No public fallback for private assets.** If a private read fails, the
  proxy returns an error. It never retries the object as public and never
  emits a Blob URL to the client.

Because a Blob store is created public or private and cannot be flipped, the
private lane is a **separate store**. The app talks to exactly one store at a
time (`BLOB_READ_WRITE_TOKEN`); only the migration spans both, and it does so
with two explicit credentials — see §6.

SDK support was verified against the installed version rather than assumed:
`@vercel/blob@2.3.3` types `BlobAccessType = 'public' | 'private'` and
document `get(…, { access: 'private', useCache })`. The in-repo comment in
`review/[reviewToken]/sample/[assetId]/route.ts` claiming private mode "is
not GA" is **stale** and is corrected by this change.

## 3. Authorization model

Authorization is unchanged in shape and is enforced **before any Blob read**.

- **Parent** — capability is the `reviewToken` in the path. Shape-checked,
  resolved through the hashed index, and the requested `assetId` must be a
  **sample on that submission**. Reference photos are never parent-readable.
  Every failure is `404`.
- **Admin** — capability is the `fr_admin_session` HttpOnly, `SameSite=Strict`,
  `Secure` cookie compared against `FAMILY_REVIEW_ADMIN_KEY`. The asset must
  belong to the addressed submission, blocking cross-submission access by
  path tampering. Unauthenticated is `403`; wrong-submission is `404`.
- **Ordering rule (new, tested).** `authorize → resolve asset → open bytes`.
  No handler may open storage before both checks pass.

## 4. Streaming / proxy behavior and response headers

Both proxies stream (no full buffering) and set, on every byte response:

```
Content-Type: <mime from the stored record, allowlisted>
X-Content-Type-Options: nosniff            (new — F-5)
Cache-Control: private, no-store, max-age=0
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow
Content-Disposition: inline; filename="<derived from stored mime>"   (F-10)
```

`Content-Type` is taken from the **stored, allowlisted** mime, never from the
upstream response, so a mislabeled object cannot pick its own type. Reads are
bounded (§ size bounds) so an oversized object cannot stream unbounded (F-9).

## 5. Metadata / schema changes

```ts
interface PhotoAsset {
  assetId: string;
  blobPathname: string;
  blobUrl?: string;        // legacy public objects only; absent when private
  storage: 'public' | 'private';
  mime: string;
  size: number;
  uploadedAt: string;
}
```

`SampleAsset` gains the same two changes. Records with no `storage` field are
legacy and read as `'public'`. `sanitizeSubmissionForPersistence` and
`normalizeSubmissionRecord` are unchanged in intent and continue to be the
single write filter and single read normalizer.

Two existing tests pin the asset key set exactly
(`family-review-no-filename-capture.test.ts`,
`family-review-token-privacy.test.ts`). Their intent is *no filename field
ever appears*. They are updated to the new exact key set — still exact, still
filename-guarding. No assertion is loosened.

## 6. Migration: a CROSS-STORE cutover

### 6.1 Why this is a cross-store copy, not an access flip

A Vercel Blob token is scoped to exactly one store, and a store is created
either public or private — an existing public store cannot be flipped. The
private lane is therefore a **different store**, and migration is a copy from
the legacy public store to the private one.

An earlier revision of this utility missed that. It copied to the same pathname
with `access:'private'` using the **ambient `BLOB_READ_WRITE_TOKEN` for both
sides**. Against a genuinely separate private store it would have failed; worse,
against one store it would have "copied" an object onto itself and then verified
that copy by reading back the very object it started from — a self-confirming
verification that reports success while nothing moved. This is the P0 that
§6.2 exists to make structurally impossible.

### 6.2 Two explicit credentials, no ambient fallback

```
FAMILY_REVIEW_SOURCE_BLOB_TOKEN   legacy PUBLIC store   READ ONLY
FAMILY_REVIEW_DEST_BLOB_TOKEN     PRIVATE store         written to
```

Every SDK call passes an explicit `token:` naming which side it talks to. The
script **never reads `BLOB_READ_WRITE_TOKEN`** — an ambient credential is
exactly what lets one store silently play both roles.

The utility fails closed, before a single byte is read and **including in dry
run**, when any of these hold:

- either variable is missing, blank, or not a well-formed Blob token;
- the two resolve to the **same store id**.

Aliasing is judged by **store id parsed from the token** (`vercel_blob_rw_<storeId>_<secret>`),
not by comparing token strings — two different secrets minted for one store are
the adversarial case a string comparison would wave through.

### 6.3 Addressing: pathname + token, never a recorded URL

Source bytes are read with `get(asset.blobPathname, { token: sourceToken })`.
The SDK derives the host from the token's own store, so the read provably lands
in the source store. The `blobUrl` recorded on a legacy asset is treated as
**untrusted** and is never fetched: it is drift- or tamper-influenced data that
could point at another store entirely. The script contains no raw `fetch()`.

### 6.4 Order of operations, per submission

1. **source read** — bytes by pathname, source token
2. **destination copy** — `access:'private'`, dest token, same pathname
3. **verification** — read the object **back out of the destination** and
   compare content type, size, and sha256 against the source bytes
4. **cutover state** — append the verified asset id and persist immediately
5. **record + index** — `buildPersistPlan()` bytes written to the **destination**
   with `storage:'private'` and `blobUrl` dropped — only once **every** asset on
   that record is verified
6. **completion** — cutover state marked complete, last

Reusing `buildPersistPlan()` means the destination record passes through the
same sanitizer as every runtime write: no plaintext review token in any pathname
or any serialized byte.

### 6.5 What it never does

- never deletes or writes to the **source** store
- never enumerates the **destination** store
- never logs a token, a private URL, a pathname, or any parent/child PII

Source reclamation stays a separate, separately-authorized operation. Any
`--delete` / `--purge` / `--remove` / `--drop` flag exits non-zero, and the
Blob delete API is neither called nor imported.

## 7. Idempotency and resumability

Cutover state lives in the **destination** store at
`{ns}/family-review/cutover/{submissionId}.json`:

```jsonc
{ "submissionId": "fr-…", "assetsVerified": ["a-…"], "recordWritten": true,
  "completedAt": "…" }
```

- **Per-asset checkpoint.** State is written immediately after each asset is
  verified, so an interruption on asset N never recopies assets 1…N-1.
- **Completed submissions are skipped** wholesale on a later run.
- **The readiness gate is set-based**, not a count: the record is withheld
  unless every asset id on the record appears in `assetsVerified`. Unrelated or
  stale ids cannot satisfy it.
- **A crash between copy and record-write** leaves assets verified and the
  record unwritten; the next run writes only the record. A crash before
  verification simply recopies that one asset — the destination write is an
  overwrite of the same pathname, so a retry is safe.
- State is never written to the source store, and never read from it.

Vercel Blob's `list`/`head` do not expose an object's access mode, so the record
and the cutover state — not the object listing — are the source of truth for
what has migrated. That is a deliberate design point.

## 8. Deletion and rollback

- Runtime deletion still goes through the storage abstraction, so a private
  asset is deleted over the token-authenticated path.
- `deleteAsset` reports success or failure rather than swallowing it (F-8), and
  admin `DELETE` surfaces a partial failure instead of an unconditional
  `ok: true`.
- The migration never deletes anything, in either store.

**Rollback.** Because the cutover only ever *adds* objects to a second store and
never touches the first, rollback is a configuration change with no data
recovery step:

1. Point the deployment's `BLOB_READ_WRITE_TOKEN` back at the **source** store.
2. Set `FAMILY_REVIEW_BLOB_ACCESS=public`.
3. Leave `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` on.

Every legacy record and object is still present and unmodified in the source
store, so the lane returns to exactly its pre-cutover behavior. The destination
store is left intact; a later re-run resumes from its cutover state rather than
starting over.

The one-way door is **phase 7 (reclamation)** — deleting source objects. Nothing
in this PR can do it, and after it runs the rollback above no longer works.

## 9. Legacy-object handling

Legacy assets keep `blobUrl` and read as `'public'`. The legacy read path is
reached only when `asset.storage !== 'private'`, and is gated by
`FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` (default on, so no existing
family is locked out). After migration completes, setting it off makes the
lane private-only and fail-closed. Legacy raw-token indexes (F-7) are out of
scope here and remain on their existing bounded-compatibility path.

## 10. Preview / Production isolation

- `withBlobNamespace` already guarantees Preview reads and writes only under
  `preview/`. The migration inherits it on **both** sides: a Preview run reads
  only `preview/…` from the source store and writes only `preview/…` to the
  destination store. Namespace isolation and store isolation are independent
  controls, and both apply.
- The migration additionally requires a **three-part** operator confirmation
  to write anything, and refuses a Production target unless all three agree
  (§ migration guard). Dry run is the default and needs no confirmation.
- Env vars introduced (names only, no values):

  | Name | Used by | Purpose |
  |---|---|---|
  | `FAMILY_REVIEW_BLOB_ACCESS` | app | `public` (default) \| `private` |
  | `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` | app | default on; off makes the lane private-only |
  | `FAMILY_REVIEW_SOURCE_BLOB_TOKEN` | migration | legacy public store, read only |
  | `FAMILY_REVIEW_DEST_BLOB_TOKEN` | migration | private destination store |
  | `FAMILY_REVIEW_MIGRATION_CONFIRM` | migration | third confirmation |

  The two migration tokens are **server-only operator credentials**. They are
  never read by the app, never logged, and never appear in output — reporting
  shows the parsed **store id** only. They must name two different stores
  (§6.2).

## 11. Observability without PII

Logs carry counts, `submissionId`, `assetId`, byte sizes, and outcome codes.
They never carry parent name, parent email, child name, review tokens, Blob
URLs, or pathnames of legacy raw-token indexes — the existing store test
already forbids interpolating `${pathname}` into logs and that guard stands.

## 12. Explicit fail-closed behavior

- No `BLOB_READ_WRITE_TOKEN` → routes `503`, as today. No pretend success.
- `FAMILY_REVIEW_BLOB_ACCESS=private` and the private write throws → the
  upload fails with `502`. It does **not** silently fall back to a public
  write.
- A private read failure → proxy error. Never a public retry, never a Blob
  URL to the client.
- Migration with unmet confirmation → dry run only, exit non-zero on any
  attempt to write.
- Migration with a missing, malformed, or **aliased** store credential → exit
  non-zero before reading anything, in dry run as well as apply (§6.2). There
  is no ambient-token fallback.
- **Default on merge is `public`** — i.e. exactly today's behavior — because
  of §1.4. Merging this PR changes no runtime behavior until an operator
  provisions a private store and flips the flag.

---

## 13. Test evidence

Run in a clean worktree at base `d6c5602` with `npm ci` (247 packages).
All commands and results verbatim.

### Focused suites (new)

```
$ node --experimental-strip-types --test tests/family-review-private-assets.test.ts
  tests 12 | pass 12 | fail 0

$ node --experimental-strip-types --test tests/family-review-image-type.test.ts
  tests 6 | pass 6 | fail 0

$ node --experimental-strip-types --test tests/family-review-asset-migration.test.ts
  tests 39 | pass 39 | fail 0

$ node --experimental-strip-types --test tests/family-review-asset-access-control.test.ts
  tests 17 | pass 17 | fail 0
```

The migration suite grew from 15 to 39 with the cross-store rewrite. What the
new cases prove:

| Guarantee | How it is proven |
|---|---|
| Source/destination cannot be confused | The source is parsed with a paren-balancing scanner (comments stripped) and **every** `get`/`put`/`list` call must pass an explicit `token: creds.…`. `put` must be `destToken` + `access:'private'`; `list` must be `sourceToken`. `BLOB_READ_WRITE_TOKEN` must appear nowhere. |
| Aliasing is rejected | Two **different** tokens minted for one store id are refused — the case a token-string comparison would pass. Reversed roles and distinct stores still succeed. |
| Missing configuration fails closed | Missing, blank, whitespace, and five malformed token shapes each refuse; both-missing reports both problems; credentials resolve **before** enumeration and before the apply gate, so a dry run fails closed too. |
| Interrupted copies resume idempotently | `assetsNeedingCopy` is exercised directly across fresh / partial / complete / stale-id states; the source is checked to prove the checkpoint write sits inside the per-asset loop and before the record write. |
| Metadata switches only after verified destination persistence | `recordIsReady` is set-based — unrelated verified ids cannot satisfy it — and `flipAssetToPrivate` is asserted to set `storage:'private'` and **drop** `blobUrl`. Source ordering is asserted end to end: copy → verify → checkpoint → readiness gate → record → completion. |
| Verification is not self-confirming | The read-back inside `copyAndVerify` must use `destToken`, and compares content type, size, and sha256. |
| Credentials never surface | `redactTokens` is exercised on real token-shaped strings; no `console.*` line may interpolate `sourceToken`/`destToken`; the report block may not contain either, nor any URL, pathname, or PII field. |
| Source is never deleted | Seven deletion-shaped flags refused; `del` neither called nor imported. |

### Tests changed, and why that is not weakening

Three pre-existing assertions were pinned to mechanisms this change replaces.
Each now asserts the same guarantee against the new mechanism, and two gained an
**additional negative** assertion. None was loosened.

| Test | Was | Now |
|---|---|---|
| `PhotoAsset shape carries blob refs only` | exact key set of 6 | exact key set of 7 (`storage` added, `blobUrl` now optional). Still exact, still the filename guard. |
| `parent sample proxy 404s wrong token or wrong asset id` | `match(/fetch\(sample\.blobUrl/)` | `match(/await openAsset\(sample\)/)` **plus** a new `doesNotMatch(/fetch\(sample\.blobUrl/)`. |
| `family-review photo picker … mobile image mime variants` | asserted `resolveImageType`, `image/jpg`, and the no-filename comment in the upload route | asserts the route calls `resolveUploadImageType`, and asserts `image/jpg` tolerance, the no-filename guarantee, **and** a new `doesNotMatch(/file\.name/)` in the shared module that now owns them. |

`tests/family-review-asset-migration.test.ts` was rewritten wholesale for the
cross-store model (15 → 39 cases). Nothing it previously asserted was dropped:
the dry-run default, the three-part confirmation, every partial path to
production, deletion refusal, bounded scoped enumeration, verification content,
and redacted reporting all survive, with the source/destination, aliasing,
resume, and credential-secrecy families added on top.

No privacy or auth control was relaxed to make anything pass.

### Full suite

```
$ npm test
  tests 1701 | pass 1701 | fail 0
```

### Build

```
$ npm run build
  exit 0 (Next.js 16.2.0, compiled successfully)
```

### Lint

```
$ npm run lint
  exit 127 — sh: eslint: command not found
```

**Lint did not run.** `eslint` is not installed by `npm ci` in this repo. This
is pre-existing and repo-wide, not a consequence of this change, but it means no
linter has seen this diff.

### End-to-end (Chromium)

```
$ npx playwright test --project=desktop-chromium \
    tests/e2e/family-review-admin-auth.spec.ts tests/e2e/public-ai-surfaces.spec.ts
  10 passed (11.2s)
```

### What was NOT verified

Neither store was contacted. No `FAMILY_REVIEW_SOURCE_BLOB_TOKEN`,
`FAMILY_REVIEW_DEST_BLOB_TOKEN`, or `BLOB_READ_WRITE_TOKEN` was used, and the
private read/write path has still **never been exercised against a live Vercel
Blob store**. Every private-path and cross-store test asserts fail-closed
behavior, credential wiring, and call ordering — not that `access:'private'`
succeeds, and not that a real two-store copy round-trips. Per §1.4 the
Production store could not serve it today regardless. First real exercise must
be a Preview deployment against a genuinely separate private store. See §14.

## 14. Residual risk

1. **Unproven against live stores.** No two-store copy has ever run. Phase 3–4
   is the first real exercise, and it must be Preview-only.
2. **The Production store cannot serve private objects today** (§1.4);
   provisioning the private destination store is an operator action.
3. **Legacy public objects are not reclaimed.** The cutover only adds to the
   destination. Every source object stays readable by anyone holding its URL
   until a separate, separately-authorized reclamation pass runs. This change
   reduces *new* exposure and stops *new* URL leakage; it does not revoke URLs
   already handed out.
4. **Edge-cached copies of legacy photos** may persist ~1 year (F-1)
   independent of any origin deletion. No cache purge is implemented.
5. **Token format assumption.** Aliasing detection parses
   `vercel_blob_rw_<storeId>_<secret>`. If Vercel changes that format, tokens
   stop parsing and the utility **refuses to run** — it fails closed, not open —
   but the format should be re-confirmed before a Production cutover.
6. **A partially-migrated submission is readable from neither store as a whole**
   until its record is written: assets exist in the destination while the record
   still lives in the source. During cutover the app must keep pointing at the
   source store; only flip it after the migration reports zero failures.
7. **F-7 (legacy raw-token index pathnames) is untouched** — out of scope, still
   on its bounded-compatibility path.
8. **No linter ran** (§13).
