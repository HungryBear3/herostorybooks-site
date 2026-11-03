# HSB Family Review private-Blob cutover — operator runbook (current main)

- **Prepared:** 2026-08-27 22:36 CDT
- **Code baseline:** `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` (`origin/main`; PR #157 + PR #160)
- **Status:** **GATE B IS NOT EXECUTABLE.** Gate A is executable and reversible.
  Gate C is executable and independent. Gate D is excluded.
- **Companion review:** `docs/reviews/hsb-private-blob-rebound-20260827.md`

Read `docs/reviews/hsb-private-blob-rebound-20260827.md` §4 before running
anything here. The runtime flip that Gate B exists to perform cannot be
done inside the approved scope on this baseline, for a reason in the
merged code rather than in the drift. This runbook is written so that the
work that *is* safe is not held hostage to the work that is not.

Nothing in this document is an authorization. Each gate needs its own
approval, issued against the exact SHA and deployment IDs recorded here.

---

## 0. Anchors — pin these before any gate

| Anchor | Value |
|---|---|
| Code baseline | `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` |
| Newest READY Production deployment | `dpl_75ozRry1tu7LRCqKQ7P2fuZrx3Xi` (`…-iscnb19v8-…`, 2026-08-27 14:50 CDT) |
| PR #157-only READY deployment | `dpl_FLCEWqJavaAmxmAV7zxDMW6Us5QK` (`…-7ehdack4e-…`, 2026-08-26 16:07 CDT) |
| **Apex-bound deployment (current live)** | `dpl_EpQG7eiGjykNQmr7CKKz8z2e8KnC` (`…-muonu0u5r-…`, pre-#157) |
| Rollback deployment | `dpl_EpQG7eiGjykNQmr7CKKz8z2e8KnC` — unchanged; it is what the apex already serves |

Re-read, read-only, immediately before any gate. Fail closed on any drift:

```
git fetch origin main && git rev-parse origin/main      # must equal f795a9d5…
vercel ls herostorybooks-site --prod
vercel inspect https://herostorybooks-site-iscnb19v8-alexy-kapluns-projects.vercel.app
vercel env ls production                                 # NAMES ONLY — never `vercel env pull`
curl -sI https://herostorybooks.com/family-review | grep -i x-content-type-options
```

The last line is the live build discriminator: `nosniff` present ⇒ the
apex is on #157-or-later; absent ⇒ the apex is still pre-#157. As of
2026-08-27 22:36 CDT it is **absent**.

## Hard prerequisites for every gate

1. **Encrypted backup complete.** Both archives written *and* independently
   read-verified, evidenced by a separate terminal receipt. Not satisfied
   as of this writing. Do not infer it from anything in this document.
2. A fresh, unexpired approval naming the exact SHA and deployment IDs in §0.
3. Read-only revalidation of §0 immediately before mutation.

---

## Gate A — private store provisioning, configuration, and additive migration

**Executable. Reversible. Changes no runtime behavior on its own.**

Everything in Gate A only *adds*: a new store, five env names the running
code either ignores or reads as its existing default, and a second copy of
Family Review objects. The source store is never written to and never
deleted from.

### A.1 Provision

Create **one** Vercel Blob store with **private** access. A store's access
mode is fixed at creation; the existing production store is public and
cannot be flipped. Mint two tokens: one on the existing public store
(source, read-only use) and one on the new private store (destination).

### A.2 Environment

Add, to Production, exactly these five names and no others:

```
FAMILY_REVIEW_SOURCE_BLOB_TOKEN                 # legacy PUBLIC store, read only
FAMILY_REVIEW_DEST_BLOB_TOKEN                   # new PRIVATE store, written to
FAMILY_REVIEW_MIGRATION_CONFIRM                 # value: i-am-migrating-production
FAMILY_REVIEW_BLOB_ACCESS                       # LEAVE AT public FOR GATE A
FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS   # LEAVE ON FOR GATE A
```

The first three are operator credentials for the migration script only —
no runtime code reads them. The last two are runtime flags; in Gate A they
stay at their existing defaults, so Gate A cannot change what a customer
sees.

Never run `vercel env pull`, never echo a token, never paste one into a
receipt. Reporting shows parsed **store ids** only.

### A.3 Distinct-store proof

Run the dry run and read the two store ids off its header. The script
refuses to proceed — including in dry run — if either token is missing,
blank, or malformed, or if the two parse to the same store id. Aliasing is
judged by store id parsed from the token, not by string comparison, so two
secrets minted for one store are caught.

### A.4 Dry run (default; writes nothing)

```
node --experimental-strip-types scripts/family-review-migrate-assets.ts
node --experimental-strip-types scripts/family-review-migrate-assets.ts --limit=25
node --experimental-strip-types scripts/family-review-migrate-assets.ts --submission=<id>
```

Preserve the redacted census and planned-object receipt. Counts,
`submissionId`, `assetId`, byte sizes, and outcome codes only — no parent
or child name, no email, no review token, no Blob URL, no pathname.

### A.5 Apply — once, only if the dry run is exact and clean

All three confirmations are required and must agree on the same target:

```
FAMILY_REVIEW_MIGRATION_CONFIRM=i-am-migrating-production \
  node --experimental-strip-types scripts/family-review-migrate-assets.ts \
  --apply --target=production
```

Missing or disagreeing confirmations exit 3 without writing a byte.

### A.6 Verify

Re-run A.5. A second run must report every asset `already_verified` and
migrate nothing. Byte revalidation re-reads both copies and compares type,
length, and SHA-256 by authenticated live-byte readback — a checkpoint is
never honoured on its recorded state alone.

### A.7 Stop conditions — abort Gate A on any of these

- either token missing, blank, malformed, or resolving to the same store id
- enumeration truncated or over the page budget (a truncated enumeration is
  a hard failure, never a partial success)
- `source_read_failed`, `too_large`, `source_type_unrecognized`,
  `content_type_mismatch`, `size_mismatch`, `dest_write_failed`, `verify_failed`
- duplicate asset identity on a record
- any customer-record drift between dry run and apply
- any non-zero failure count at all

### A.8 Gate A rollback

Nothing to undo in data: the source store is untouched. Remove the five env
names if desired. **Delete neither store.** The destination store is the
resume anchor for a later attempt.

### A.9 Gate A honest outcome

At the end of Gate A the private store holds a verified copy and the
application still reads the public one. Public exposure is **unchanged**,
and child photos now exist in two places rather than one. That is the
correct state to be in only if Gate B is expected to follow shortly. If
Gate B is not going to happen, Gate A should not be run either.

---

## Gate B — runtime cutover and combined smoke

### **BLOCKED. Do not attempt on this baseline.**

The runtime Family Review code addresses its store through the ambient,
app-wide `BLOB_READ_WRITE_TOKEN`; nothing at runtime reads
`FAMILY_REVIEW_DEST_BLOB_TOKEN`. So:

- setting `FAMILY_REVIEW_BLOB_ACCESS=private` alone points private writes
  at the **public** store, which rejects them — new parent-photo and admin
  sample uploads start returning 502;
- repointing `BLOB_READ_WRITE_TOKEN` at the private store is both outside
  the approved five names and destructive: it moves `orders/*.json`,
  `orders/*/photo-*`, `orders/*/*voice-*`, `payment-recovery/*.json`, and
  `recovery/*.json` to a store the migration never populated.

Full analysis: `docs/reviews/hsb-private-blob-rebound-20260827.md` §4.

**What unblocks it:** a code change giving the Family Review storage
boundary its own explicit store credential, so the lane can move while the
order lane stays put. That is a new implementation task with its own
review. It is not an operator workaround and must not be improvised in a
cutover window.

### B.1 The smoke that Gate B will need (specified, not runnable yet)

Recorded now so the eventual approval inherits it rather than reinventing
it. **Both lanes, same deployment, same session** — PR #160 must be proven
intact by the same run that proves the storage flip:

*Checkout lane (PR #160 preservation):*
- `/checkout` returns 200 and its bundle still contains the
  `stripe-handoff-fallback` element
- a submit hands off to `checkout.stripe.com` immediately, with no timer
  between the validated URL and the navigation
- a double-tap creates exactly one order and one Stripe session
- a dropped hand-off leaves a working manual link resuming the **same**
  session, and the attempt id survives
- an unapproved redirect target fails closed and keeps the "you have not
  been charged" recovery copy

*Family Review lane:*
- parent reference-photo upload succeeds and records `storage: 'private'`
  with **no** `blobUrl`
- admin sample upload succeeds; admin board lists and reads submissions
- same-origin proxy read succeeds with the correct capability
- unauthenticated, wrong-token, and cross-submission reads return a generic
  refusal
- no direct Blob URL or token appears in HTML, JSON, redirects, headers,
  logs, traces, or analytics
- responses carry `no-store` and `nosniff`
- a legacy (unmigrated) asset still reads while
  `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` is on

*Legacy health:* apex `/`, `/family-review`, `/family-review/admin`,
`/checkout`, `/status/<id>`, and `www` → apex redirect all behave as before.

### B.2 Gate B rollback (for the eventual approval)

Configuration only; no data recovery step, because the cutover only ever
adds to the second store.

1. Restore the runtime store binding to the source store.
2. Set `FAMILY_REVIEW_BLOB_ACCESS=public`.
3. Leave `FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS` **on**.
4. If a deployment-level rollback is needed, restore `dpl_EpQG7eiGjykNQmr7CKKz8z2e8KnC`.

**Delete neither store, and delete no object in either store.** Both are
preserved as evidence and as the resume anchor.

---

## Gate C — apex / www promotion

**Executable, independent of Gates A and B, and currently the most
consequential of the four.**

The apex serves `dpl_EpQG7…`, a pre-#157 build. Two independent read-only
probes confirm it (review §3.1). Consequences today:

- the #157 Family Review privacy hardening is inert for customers;
- **the #160 checkout Stripe hand-off incident fix is inert for customers** —
  the 2026-08-26 23:55 CDT failure mode (durable draft order + open Stripe
  session + no payment, no error) is still reachable in production.

Promoting `dpl_75ozRry1tu7LRCqKQ7P2fuZrx3Xi` to the apex would ship both.
It has no dependency on the private-Blob work: with
`FAMILY_REVIEW_BLOB_ACCESS` unset, `familyReviewAssetStorageMode()` returns
`'public'`, so the Family Review lane keeps writing and reading public
objects exactly as the current apex build does. Promoting also ships #157's
other, non-storage changes — the added `nosniff` headers, a `deleteAsset`
that reports failure instead of swallowing it, and the admin `DELETE` that
surfaces a partial failure instead of an unconditional `ok: true`. Those are
behavior changes and belong in the Gate C approval's scope, even though none
of them depends on a private store.

This runbook does **not** authorize that promotion — it is a separate
customer-facing decision with its own risk surface, and it should be
approved on the checkout incident's merits rather than as a side effect of
a storage cutover. It is recorded here because a cutover packet that left
it unstated would be misleading about what customers are actually running.

Rollback for Gate C: re-point the apex at
`dpl_EpQG7eiGjykNQmr7CKKz8z2e8KnC`, which is the current binding.

---

## Gate D — legacy source reclamation

**Excluded. Not authorized by anything in this packet.**

Deleting source objects is the one-way door: after it, the Gate B rollback
in B.2 no longer works. It requires, in order: a completed and stable Gate
B, an observation window, a fresh zero-public-dependency census, and a
**new** approval issued specifically as deletion authority.

Note that reclamation does not revoke URLs already handed out, and edge
caches may retain legacy public photos for roughly a year (F-1)
independent of origin deletion. No cache purge exists.

---

## Receipt fields to record for whichever gate runs

- exact base SHA and the three deployment IDs, re-read at execution time
- store ids (parsed, never tokens) for source and destination
- migration counts: submissions / assets / bytes, dry run and apply
- verification outcome per asset: type, byte length, SHA-256 match
- private-access checks: authorized read, unauthenticated refusal,
  wrong-capability refusal, cross-submission refusal
- leakage checks: no Blob URL or token in HTML, JSON, redirects, headers,
  logs, traces, analytics
- persisted-record state: `storage: 'private'`, `blobUrl` absent
- checkout smoke results (PR #160 preservation)
- deployment/config state before and after; apex binding
- rollback readiness: both stores intact, rollback deployment READY
- explicit confirmation that no source object was deleted, reclaimed,
  overwritten, or rotated
