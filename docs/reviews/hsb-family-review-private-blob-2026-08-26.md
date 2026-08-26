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

## 6. Migration phases

`scripts/family-review-migrate-assets.ts`, **dry-run by default**.

1. **Enumerate** only Family Review-owned records: list
   `{ns}/family-review/submissions/`, read each record, and take asset
   pathnames **from the record**. Object prefixes are never globbed and no
   prefix outside the submission list is touched.
2. **Skip** any asset already `storage: 'private'` (idempotency, §7).
3. **Copy** to the same pathname with `access:'private'`. The source object
   is **never deleted** during copy.
4. **Verify** byte length, sha256, and content type of the written object
   before it counts as migrated.
5. **Update metadata** only after verification passes — set
   `storage:'private'`, drop `blobUrl`, persist through the normal
   `persistSubmission` filter.
6. **Report** aggregate, redacted counts only.

Source deletion is a **separate future operation**. It is not implemented
here; the script hard-refuses any deletion request (§8).

## 7. Idempotency and resumability

- The idempotency key is the record's own `storage` field, not a side file:
  a migrated asset is skipped on every later run. Vercel Blob's `list`/`head`
  do **not** expose an object's access mode, so the record is the only
  reliable source of truth — a deliberate design point.
- Metadata is written only after byte verification, so a crash between copy
  and record-write leaves the asset unmigrated and simply retried. The copy
  is an overwrite of the same pathname, so a retry is safe.
- Per-submission progress: each record is updated independently, so a partial
  run resumes exactly where it stopped.
- `--limit` bounds a run; `--submission=<id>` targets one record.

## 8. Deletion and rollback

- Deletion continues to go through the same storage abstraction, so a private
  asset is deleted with the token-authenticated path.
- `deleteAsset` now **reports success or failure** instead of swallowing it
  (F-8), and the admin `DELETE` surfaces a partial-failure result rather than
  an unconditional `ok:true`.
- The migration never deletes. Source deletion is hard-disabled: the script
  exits non-zero on any `--delete-source` flag with a message pointing at the
  separate authorization required.
- **Rollback** is a single env flip back to `public` (§10). Because migration
  never deletes the source object, a rolled-back deployment still reads every
  legacy asset. Records already flipped to `storage:'private'` continue to
  read privately, which is why rollback is safe only while the private store
  remains provisioned.

## 9. Legacy-object handling

Legacy assets keep `blobUrl` and read as `'public'`. The legacy read path is
reached only when `asset.storage !== 'private'`, and is gated by
`FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` (default on, so no existing
family is locked out). After migration completes, setting it off makes the
lane private-only and fail-closed. Legacy raw-token indexes (F-7) are out of
scope here and remain on their existing bounded-compatibility path.

## 10. Preview / Production isolation

- `withBlobNamespace` already guarantees Preview reads and writes only under
  `preview/`. The migration inherits it: a Preview run can only ever see
  Preview objects.
- The migration additionally requires a **three-part** operator confirmation
  to write anything, and refuses a Production target unless all three agree
  (§ migration guard). Dry run is the default and needs no confirmation.
- Env vars introduced (names only, no values):
  `FAMILY_REVIEW_BLOB_ACCESS`, `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS`,
  `FAMILY_REVIEW_MIGRATION_CONFIRM`.

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
  tests 15 | pass 15 | fail 0

$ node --experimental-strip-types --test tests/family-review-asset-access-control.test.ts
  tests 17 | pass 17 | fail 0
```

### Full suite

```
$ npm test
  tests 1677 | pass 1677 | fail 0
```

First run of the full suite failed 3 tests, all of them assertions pinned to a
mechanism this change intentionally replaces. Each was updated to assert the
same guarantee against the new mechanism; none was loosened:

| Test | Was | Now |
|---|---|---|
| `PhotoAsset shape carries blob refs only` | exact key set of 6 | exact key set of 7 (`storage` added, `blobUrl` now optional). Still exact, still the filename guard. |
| `parent sample proxy 404s wrong token or wrong asset id` | `match(/fetch\(sample\.blobUrl/)` | `match(/await openAsset\(sample\)/)` **plus** a new `doesNotMatch(/fetch\(sample\.blobUrl/)` — strictly stronger. |
| `family-review photo picker … mobile image mime variants` | asserted `resolveImageType`, `image/jpg`, and the no-filename comment in the upload route | asserts the route calls `resolveUploadImageType`, and asserts `image/jpg` tolerance, the no-filename guarantee, **and** a new `doesNotMatch(/file\.name/)` in the shared module that now owns them. |

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

**Lint did not run.** `eslint` is not installed by `npm ci` in this repo, so
the lint step produced no signal either way. This is a pre-existing condition
of the repo, not a consequence of this change, but it means no linter has
seen this diff.

### End-to-end (Chromium)

```
$ npx playwright test --project=desktop-chromium tests/e2e/family-review-admin-auth.spec.ts
  2 passed (9.3s)

$ npx playwright test --project=desktop-chromium tests/e2e/public-ai-surfaces.spec.ts
  8 passed (10.2s)
```

### What was NOT verified

The private read/write path was **never exercised against the live Vercel Blob
service**. No `BLOB_READ_WRITE_TOKEN` was used and no store was contacted, by
design. Every private-path test asserts fail-closed behavior and call ordering,
not that `access:'private'` succeeds against a real store — which, per §1.4, it
currently would **not** against the Production store. First real exercise must
be a Preview deployment against a private-capable store. See §14.

## 14. Residual risk

1. **Unproven against a live private store.** See above. A Preview soak is the
   only way to prove the round trip.
2. **The Production store cannot serve private objects today** (§1.4).
   Provisioning is an operator action; until then the flag must stay `public`.
3. **Legacy public objects are not reclaimed.** Migration copies and verifies
   but never deletes, so every legacy object remains readable by anyone holding
   its URL until a separate, separately-authorized deletion pass runs. This
   change reduces *new* exposure and stops *new* URL leakage; it does not
   revoke URLs already handed out.
4. **Edge-cached copies of legacy photos** may persist for up to a year (F-1)
   independent of any origin deletion. No cache purge is implemented.
5. **F-7 (legacy raw-token index pathnames) is untouched** — out of scope here
   and still on its bounded-compatibility path.
6. **No linter ran** (§13).
