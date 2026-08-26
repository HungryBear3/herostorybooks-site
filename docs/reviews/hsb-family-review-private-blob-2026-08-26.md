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

### 6.3a Streaming, not buffering

The 25 MB ceiling is enforced **while bytes move**, not after they land.

`meterAndSniff()` peeks just enough leading bytes to identify the format, then
hands back a stream that hashes and counts each chunk as it is consumed and
`controller.error()`s — cancelling the upstream reader — the moment the ceiling
is passed. The destination `put()` receives that stream directly, so an
oversized or hostile object is cut off mid-flight instead of being read whole
into memory and rejected afterwards. `multipart: true` plus
`maximumSizeInBytes` gives the SDK a second, independent ceiling behind the
metering transform.

The verification read-back uses `digestStream()`, which hashes and counts as
chunks arrive and retains only the leading sniff bytes. **No code path
materialises a whole asset** — asserted by a test that forbids `arrayBuffer()`,
`.text()`, and `Buffer.from` anywhere in the copy path.

This matters beyond memory pressure: the previous revision read the entire
object and *then* compared its length, so the ceiling protected nothing that
had not already been paid for.

### 6.3b Content type is sniffed, not echoed

The previous revision wrote `contentType: asset.mime` and then "verified" the
copy by checking that the destination reported that same mime back. That
confirms only that the SDK echoes the header it was handed — it is bookkeeping,
not verification, and it would happily propagate a record whose declared type
had nothing to do with its bytes.

Now:

1. the type is **sniffed from the source bytes** via the same magic-byte
   detector both upload routes use;
2. the record's declared mime must **agree** with those bytes, applying the same
   `image/jpg -> image/jpeg` and `image/heif -> image/heic` equivalences, or the
   asset fails `content_type_mismatch`;
3. bytes matching no supported format fail `source_type_unrecognized`, whatever
   the record claims;
4. the **sniffed** type is what gets written to the destination;
5. after the copy, the destination object's **own leading bytes are re-sniffed**
   and must agree — a content check, not a header check.

The streamed length is also compared against the record's declared `size`, so a
source object that changed under the migration fails `size_mismatch` rather than
being silently copied.

When the mime check fails the metered body is **cancelled** before returning.
Nothing downstream will consume it at that point, and cancelling propagates to
the upstream reader, releasing the source connection instead of leaving it open
until garbage collection.

### 6.3c SDK finding: `useCache` is private-only (Preview soak, 2026-08-26)

A Preview soak against a real, separately-provisioned private store found that
**`@vercel/blob`'s `get()` returns HTTP 400 for a PUBLIC read that supplies
`useCache`**. The same public object returned HTTP 200 as soon as the field was
removed. The SDK's own documentation says `useCache` is "only effective for
private blobs (ignored for public blobs)" — in practice it is not ignored on the
public path, it is rejected, and it took the whole read with it.

Every read that touched the legacy public source store carried
`useCache: false`, so **source enumeration and every source byte read would have
failed outright** against a real store. This was invisible to every test written
before the soak, because none of them crossed the SDK boundary.

The rule now lives in one place per side rather than at each call site:

```ts
sourceGetOptions(token)  // { access: 'public',  token }                 no useCache
destGetOptions(token)    // { access: 'private', token, useCache: false }
```

All six reads in the migration go through these builders. `useCache: false` is
retained on the private side, where it is honoured and is what stops a CDN copy
from answering a verification read-back with stale bytes.

The same regression existed in the app: `getJsonAtPath` in
`src/lib/family-review/store.ts` was changed earlier in this branch to pass
`useCache: false` unconditionally, including on the **public** attempt — which is
the lane's *default* mode. It now sends the field only for a private read. The
baseline never sent it, so this restores baseline behaviour on the public path.

**Not fixed here (pre-existing, out of scope):** `src/lib/orders.ts` passes
`useCache: false` on a public `get()` in `readBlobText`'s authenticated-fallback
path (and two similar sites). Those predate this branch and belong to the order
pipeline, not Family Review. They are subject to the same 400 and should be
looked at separately — flagged, not touched.

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

### 6.6 A truncated enumeration is a hard failure

Paging over the submissions prefix is bounded (40 pages x 250). If that budget
is exhausted while the store still reports `hasMore` with a cursor, the run
**aborts with exit code 5** instead of returning a short list.

A silently-truncated enumeration is the most dangerous possible outcome here: it
looks exactly like a completed migration — zero failures, a clean tally — while
leaving records behind that an operator would then believe were migrated. The
error names the pages scanned and objects seen, and tells the operator to raise
the budget or narrow the run with `--submission=<id>`.

## 7. Idempotency, resumability, and checkpoint binding

Cutover state lives in the **destination** store at
`{ns}/family-review/cutover/{submissionId}.json`:

```jsonc
{
  "version": 1,
  "submissionId": "fr-...",
  "recordFingerprint": "<sha256 of the record's asset shape>",
  "assetsVerified": [
    { "kind": "photo", "assetId": "a-...", "pathname": "...",
      "size": 1234, "mime": "image/jpeg", "sourceSha256": "<64 hex>" }
  ],
  "recordWritten": true,
  "completedAt": "..."
}
```

### 7.1 What a checkpoint is bound to

A checkpoint is never a bare "this id is done". Every entry carries the asset's
**full identity** — `{kind, assetId, pathname, size, mime, sourceSha256}` — and
the state as a whole is bound to the submission id and a deterministic
**record fingerprint**.

The fingerprint is a sha256 over the submission id plus the sorted identity of
every asset, so anything added, removed, repointed, resized, or retyped changes
it. It deliberately **excludes** volatile fields (`updatedAt`, `status`,
`feedback`): those change constantly through normal admin work and must not
throw away a half-finished copy.

The identity key is `kind:assetId`, **not** `assetId`. A photo and a sample may
legitimately share an asset id while living at different pathnames; keying on
the id alone would let one copy mark both verified and quietly skip a real
object.

### 7.2 Gate one: shape validation

`validateCutoverState()` revalidates the binding on every run and discards
anything it cannot stand behind:

| Condition | Reason code | Effect |
|---|---|---|
| Not an object / missing fields | `state_malformed` | whole state discarded |
| `version` is not 1 | `state_version_unknown` | whole state discarded |
| `submissionId` names another submission | `state_foreign_submission` | whole state discarded |
| Fingerprint does not match the record | `record_changed` | whole state discarded |
| `assetsVerified` is not an array | `state_malformed` | whole state discarded |
| Entry is not identity-shaped, or its hash is not 64 hex | `entry_malformed` | that entry dropped |
| Entry repeats a key already seen | `entry_duplicate` | the repeat dropped |
| Entry names an asset not on the record | `entry_not_on_record` | that entry dropped |
| Entry's identity differs from the record's | `entry_identity_mismatch` | that entry dropped |
| `completedAt` present without full revalidated coverage | `completion_revoked` | completion dropped |

A record carrying a genuinely duplicated identity (the same `kind:assetId`
twice) is refused outright, before state is even read.

### 7.3 Gate two: byte revalidation

**Shape validation cannot see bytes.** A checkpoint can be perfectly well-formed
and still describe nothing that is true:

- the source object replaced in place with **same-path, same-length,
  same-sniffed-type** content;
- a `sourceSha256` that is 64 valid hex characters and simply invented;
- the destination object deleted, truncated, or overwritten since the copy.

So passing gate one is not enough to skip work. On resume, **every surviving
checkpoint is re-proved against the current bytes on both sides**, each read
through its own explicit credential — source via `sourceReader` (public access,
source token), destination via `destReader` (private access, dest token).

Both reads stream through `digestStream()` and are ceiling-enforced; neither
side is buffered. A checkpoint is retained only if **all** of these hold:

1. the entry's full identity equals the record's;
2. the pathname lives under `family-review/{photos|samples}/{submissionId}/`
   — catching entries spliced in from another submission under an edited
   top-level `submissionId`;
3. the live source still sniffs to the recorded mime;
4. the live source's length equals the record's declared size;
5. the live source's hash equals the **recorded** `sourceSha256`;
6. the destination object exists, is within the ceiling, sniffs to the same
   mime, and matches the source's size and hash.

| Reason code | What it means |
|---|---|
| `identity_mismatch` | entry no longer describes the record's asset (checked before any read) |
| `submission_binding_mismatch` | pathname belongs to a different submission |
| `source_missing` / `dest_missing` | object absent or unreadable |
| `source_too_large` / `dest_too_large` | exceeded the ceiling mid-stream |
| `source_type_changed` / `dest_type_mismatch` | bytes no longer sniff to the expected type |
| `source_size_changed` / `dest_size_mismatch` | length no longer agrees |
| `source_hash_changed` | **the source bytes were replaced** |
| `dest_hash_mismatch` | **the destination bytes were replaced** |

Any revoked entry is dropped and its asset recopied. Because completion is
re-derived from what is still proven, **one revoked asset withdraws
`completedAt` and `recordWritten` for the whole record**, so the record is
rewritten after the recopy.

### 7.4 completedAt is never taken at face value

`completedAt` survives a run only after **both** gates: the state validates,
byte revalidation re-proves every entry, `recordWritten` is true, and every
asset identity on the current record has a surviving verified entry. A record
with no assets can never be marked complete. The migration reads `completedAt`
only from the twice-validated result, never from the raw file.

### 7.5 Crash behaviour

- **Crash mid-asset** — that asset has no checkpoint; it is recopied.
- **Crash between copy and record write** — all assets revalidate; the next run
  writes only the record.
- **Record changed between runs** — fingerprint mismatch at gate one; everything
  is recopied and the stale completion revoked.
- **Source or destination bytes changed between runs** — caught at gate two;
  those assets are recopied and completion is withdrawn.
- **State file tampered** — untrustworthy parts are dropped at whichever gate
  sees them first.

### 7.6 The cost of gate two

Byte revalidation re-reads **both** copies of every checkpointed asset on every
resume. A resumed run is therefore not cheap: a submission that is already
complete still costs a full streaming read of its source and destination objects
before it can be skipped.

That is a deliberate trade. The alternative — trusting a checkpoint because it
is well-formed — is exactly the class of self-confirming check this whole
design has been correcting: it would report `already_verified` for an asset
whose bytes had been swapped underneath it. Correctness over speed, and the
reads are streamed and bounded so the cost is bandwidth and time, not memory.

`--submission=<id>` and `--limit=N` exist to keep a resumed run's scope
proportionate.

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
- Asset exceeding 25 MB → the stream errors mid-flight and the asset fails
  `too_large`; it is never buffered whole first (§6.3a).
- Source bytes matching no supported image type, or contradicting the record's
  declared mime → `source_type_unrecognized` / `content_type_mismatch`. Never
  relabelled, never copied (§6.3b).
- Source enumeration exhausting its page budget with more results pending →
  exit code 5. A partial scan is never reported as a completed run (§6.6).
- Cutover state that does not revalidate against its binding → discarded, and
  the affected assets are recopied (§7.2).
- A checkpoint whose current source or destination bytes no longer match the
  recorded proof → revoked, completion withdrawn, asset recopied (§7.3). A
  well-formed checkpoint is never trusted on shape alone.
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
  tests 103 | pass 103 | fail 0

$ node --experimental-strip-types --test tests/family-review-asset-access-control.test.ts
  tests 17 | pass 17 | fail 0
```

The migration suite is now 103 cases (15 -> 39 cross-store, 39 -> 72 checkpoint
binding + streaming + sniffing + enumeration, 72 -> 95 byte revalidation,
95 -> 103 the useCache SDK fix). What they prove:

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
| The ceiling is enforced **while streaming** | A counting source offers 10 000 bytes against a 1 000-byte ceiling; the test asserts the stream errors, `settled` rejects, and **the source produced fewer than 200 of 1 000 chunks** — proving early cancellation rather than buffer-then-reject. Same for the read-back via `digestStream`. A separate test forbids `arrayBuffer()`, `.text()`, and `Buffer.from` anywhere in the copy path. |
| Content type comes from bytes | PNG bytes recorded as `image/jpeg` fail `content_type_mismatch`; HTML bytes fail `source_type_unrecognized` under every claimed type; agreeing records pass, and `image/jpg` is not treated as a spoof. Source asserts the write uses `sniffed.mime`, never `identity.mime`, and that the destination's own bytes are re-sniffed. |
| A truncated enumeration fails loudly | A pager that always reports `hasMore` throws `EnumerationTruncatedError` carrying pages scanned and objects seen; an in-budget scan returns everything; `hasMore` with no cursor ends cleanly rather than throwing; source asserts exit code 5. |
| Checkpoints are bound, not bare ids | Foreign submission, unknown version, malformed state, non-array `assetsVerified`, bad/short/uppercase hashes, non-object entries, entries not on the record, and drifted identities are each rejected with their own reason code. |
| A changed record invalidates the checkpoint | A replaced sample and a resized photo each flip the fingerprint, discard the whole checkpoint, and force a full recopy. |
| Reused ids across kinds are distinct assets | The same `assetId` on a photo and a sample yields two identity keys; verifying the photo leaves the sample pending and the readiness gate closed. A genuinely duplicated identity on one record is detected and the record refused before state is read. |
| `completedAt` is re-derived | Completion is revoked when coverage is partial, when `recordWritten` is false, and for an empty record; source asserts it is read only from validated state. |
| A checkpoint is never trusted on shape alone | Behavioural: with injected readers serving real chunked streams, a **same-path/same-size/same-MIME source replacement** yields `source_hash_changed`; an **invented 64-hex hash** yields `source_hash_changed`; a **missing destination** yields `dest_missing`; a **destination byte replacement** yields `dest_hash_mismatch`; truncation and type changes yield their own codes. |
| A COMPLETED state with stale bytes is revoked | The same state passes shape validation cleanly (`reasons: []`, `completedAt` intact) and is then revoked by byte revalidation — `completedAt` cleared, `recordWritten` false, the asset queued for recopy. |
| One revoked asset withdraws the whole record's completion | `reviseStateAfterRevalidation` drops `completedAt` and `recordWritten` when any entry fails, so the record is rewritten after recopy. |
| Both sides are read through their OWN credential | `sourceReader` is `access:'public'` + `sourceToken` and contains no `destToken`; `destReader` is `access:'private'` + `destToken` and contains no `sourceToken`. Identity failure short-circuits **before any read**. |
| A failed MIME check releases the source | Behavioural: a stream whose `cancel()` sets a flag is confirmed cancelled; source asserts `metered.body.cancel()` sits between the MIME gate and `put`. |
| `useCache` never reaches a public read | Behavioural: `sourceGetOptions()` is shape-pinned to exactly `{access, token}` with no `useCache`; `destGetOptions()` is pinned to `{access, token, useCache:false}`. Structural: no `get()` whose options are public carries `useCache`, the source builder itself never grows one, every private read keeps `useCache:false`, and **all six reads go through a builder** so the rule cannot be bypassed inline. |
| Source and destination options cannot be confused | The builders fix disjoint access modes; no call site passes `sourceGetOptions(creds.destToken)` or the reverse, and every builder/token pairing is asserted to match. |
| The app's public record read is fixed too | `getJsonAtPath` must spread `useCache` only when `access === 'private'`; the unconditional form is asserted absent. |
| The fingerprint is stable under normal work | Deterministic, order-independent, changes on any identity change, and unchanged by `updatedAt` / `status` / `feedback`. |

### Tests changed, and why that is not weakening

Three pre-existing assertions were pinned to mechanisms this change replaces.
Each now asserts the same guarantee against the new mechanism, and two gained an
**additional negative** assertion. None was loosened.

| Test | Was | Now |
|---|---|---|
| `PhotoAsset shape carries blob refs only` | exact key set of 6 | exact key set of 7 (`storage` added, `blobUrl` now optional). Still exact, still the filename guard. |
| `parent sample proxy 404s wrong token or wrong asset id` | `match(/fetch\(sample\.blobUrl/)` | `match(/await openAsset\(sample\)/)` **plus** a new `doesNotMatch(/fetch\(sample\.blobUrl/)`. |
| `family-review photo picker … mobile image mime variants` | asserted `resolveImageType`, `image/jpg`, and the no-filename comment in the upload route | asserts the route calls `resolveUploadImageType`, and asserts `image/jpg` tolerance, the no-filename guarantee, **and** a new `doesNotMatch(/file\.name/)` in the shared module that now owns them. |

`tests/family-review-asset-migration.test.ts` was rewritten again for the bound
checkpoint model, then extended for byte revalidation (39 → 72 → 95 cases).
Nothing it previously asserted was dropped:
the dry-run default, the three-part confirmation, every partial path to
production, deletion refusal, bounded scoped enumeration, verification content,
and redacted reporting all survive, with the source/destination, aliasing,
resume, and credential-secrecy families added on top.

No privacy or auth control was relaxed to make anything pass.

### Full suite

```
$ npm test
  tests 1765 | pass 1765 | fail 0
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

### Preview soak, 2026-08-26 — what was actually provisioned and run

A real soak was performed. Recorded here in full because it is the first time
any of this touched a live store:

- a **separate private Preview Blob store** was provisioned as the destination;
- **one synthetic public-source submission** was created in the legacy store as
  migration input — synthetic test data, no customer record;
- the run was **stopped before any destination write**.

What it found is §6.3c: a public `get()` carrying `useCache` returns HTTP 400,
and the same object returns 200 without it. That defect would have failed source
enumeration and every source byte read on the first real run.

**No customer or Production data was read, copied, or modified. No merge, no
source deletion, no Production configuration change, no Production deploy, and
no customer-facing action occurred.**

### What is still NOT verified

The soak stopped before the destination write, so the following remain
unexercised against a live store:

- that `put()` accepts a `ReadableStream` body with `multipart: true` and
  `maximumSizeInBytes` against a real private store;
- that a private `get()` read-back returns a stream whose `contentType` matches
  what was written;
- that a full two-store copy round-trips, and that byte revalidation passes
  against genuinely stored objects;
- that the streaming ceiling behaves as expected when the SDK, rather than a
  test fixture, is producing the stream.

The in-process logic behind all of those is tested against real streams and
state objects; what is untested is the boundary. The soak should be resumed
through a destination write once the fix in this commit is deployed to Preview.

## 14. Residual risk

1. **Still unproven past the source side.** The Preview soak reached the source
   store and stopped before any destination write, so no two-store copy has run
   end to end. In
   particular the streamed `put()` (`ReadableStream` body + `multipart: true` +
   `maximumSizeInBytes`) is untested against a real store; if the SDK buffers a
   stream internally, the in-process ceiling still fires but the memory benefit
   may not materialise. Phase 3-4 is the first real exercise, Preview only.
2. **The Production store cannot serve private objects today** (§1.4);
   provisioning the private destination store is an operator action.
3. **Legacy public objects are not reclaimed.** The cutover only adds to the
   destination. Every source object stays readable by anyone holding its URL
   until a separate, separately-authorized reclamation pass runs. This change
   reduces *new* exposure and stops *new* URL leakage; it does not revoke URLs
   already handed out.
4. **Edge-cached copies of legacy photos** may persist ~1 year (F-1)
   independent of any origin deletion. No cache purge is implemented.
5. **Resume is no longer cheap.** Byte revalidation re-reads both copies of
   every checkpointed asset before it may be skipped (§7.6). A large already-
   complete namespace costs a full streaming read of both stores per run. Scope
   a resumed run with `--submission=<id>` / `--limit=N` where that matters. The
   previous revision's silent-byte-change gap is closed by this, not worked
   around.
6. **Other `useCache`-on-public sites remain, outside this lane.**
   `src/lib/orders.ts` passes `useCache: false` on a public `get()` in
   `readBlobText`'s authenticated-fallback path and two similar sites. They
   predate this branch and were deliberately not touched, but they are subject
   to the same HTTP 400 and should be triaged separately.
7. **Token format assumption.** Aliasing detection parses
   `vercel_blob_rw_<storeId>_<secret>`. If Vercel changes that format, tokens
   stop parsing and the utility **refuses to run** — it fails closed, not open —
   but re-confirm before a Production cutover.
8. **A partially-migrated submission spans both stores** (assets in the
   destination, record still in the source) until its record is written. Keep
   the app pointed at the source during cutover; flip only after the migration
   reports zero failures.
9. **Legacy assets whose bytes are not a supported image** will fail
   `source_type_unrecognized` and block their record from completing. That is
   deliberate — such an object should be looked at, not copied — but it means an
   operator may need to triage individual records rather than expecting a clean
   sweep.
10. **F-7 (legacy raw-token index pathnames) is untouched** — out of scope, still
   on its bounded-compatibility path.
11. **No linter ran** (§13).
