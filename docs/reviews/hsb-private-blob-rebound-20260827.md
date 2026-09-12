# HSB Family Review private-Blob cutover — rebound review

- **Prepared:** 2026-08-27 22:36 CDT
- **Base SHA reviewed:** `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` (verified `== origin/main` at fetch time)
- **Branch / worktree:** `cc/hsb-private-blob-rebound-20260827`, fresh worktree cut from that exact commit
- **Verdict:** **BLOCKED — the runtime cutover is not executable inside the approved scope, and the one action that would make it executable strands the order lane**
- **Mutation count:** zero. No deploy, promotion, alias change, env write, store provisioning, migration run, or customer/order/payment/provider action.

This is a documentation-only review. It supersedes nothing: the
2026-08-27 approval packet and the 15:17 CDT fail-closed blocker receipt
both remain accurate for what they asserted. What follows is the drift
reconciliation they asked for, plus a defect neither of them had reached.

---

## 1. Baseline gate — PASS

| Check | Result |
|---|---|
| `git fetch origin main` → `origin/main` | `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` |
| Worktree HEAD | `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` |
| Contains PR #157 | yes — `edf23f8ea588bc4422da0d5126b483051bc29359` is the direct parent |
| Contains PR #160 | yes — `f795a9d` **is** the #160 merge |
| Working tree | clean; no existing worktree or dirty branch touched |

`f795a9d` is `edf23f8` plus exactly one commit. There is no third party
in the drift: current main is the approved private-Blob tree with the
checkout fix stacked on top.

## 2. Coexistence review, PR #157 × PR #160 — PASS

**Disjoint by construction.** The two changes share no file:

- #157 (`d6c5602..edf23f8`), 19 files: `middleware.ts`,
  `scripts/family-review-migrate-assets.ts`, `src/lib/family-review/*`,
  `src/app/api/family-review/**`, `src/app/family-review/admin/admin-board.tsx`,
  6 test files, 1 review doc.
- #160 (`edf23f8..f795a9d`), 8 files: `src/lib/checkout-handoff.ts`,
  `src/app/checkout/checkout-form.tsx`, 5 test files, 1 review doc.

Intersection: empty.

**The one shared runtime surface is `middleware.ts`, and it is clean.**
#157 added `X-Content-Type-Options: nosniff` to two header helpers and
nothing else. The paths those helpers serve are matched by
`FAMILY_REVIEW_PATH` and `CUSTOMER_REVIEW_PRIVATE_PATH`. `/checkout`
matches neither — it matches only `OPERATIONAL_NOINDEX_PATH`, which sets
`X-Robots-Tag` and nothing more. In particular the family-review CSP
(`form-action 'self'`, `connect-src 'self'`) is **not** applied to
`/checkout`, so it cannot interfere with #160's same-tab hand-off to
`checkout.stripe.com`. Verified by reading the matcher order in
`middleware.ts:97-131` and confirmed live: `/family-review` carries the
CSP, `/checkout` does not.

**No semantic coupling.** `src/lib/checkout-handoff.ts` touches no blob,
storage, or family-review symbol; `src/lib/family-review/*` touches no
checkout symbol. The only test file #160 modified,
`tests/payment-recovery-contract.test.ts`, is unrelated to the Family
Review lane.

Conclusion: preserving PR #160 across a Family Review storage cutover is
not a merge problem. It is a *deployment* problem — see §4.

## 3. Deployment anchors, independently re-read — RECONCILED (with one correction)

Re-read read-only with `vercel ls --prod`, `vercel inspect`, `vercel env ls production`,
and unauthenticated `curl`. No secret value was read or printed.

| Anchor | Supplied in evidence | Independently confirmed |
|---|---|---|
| Newest READY Production | `dpl_75ozRry1tu7LRCqKQ7P2fuZrx3Xi` | yes — created 2026-08-27 14:50:47 CDT, `…-iscnb19v8-…` |
| Current-main SHA | `f795a9d5bc4f62c5b895d08350b281bdcbf6add5` | yes |
| Approved-baseline READY | `dpl_FLCEWqJavaAmxmAV7zxDMW6Us5QK` | yes — created 2026-08-26 16:07:02 CDT, `…-7ehdack4e-…` |
| Apex rollback deployment | `dpl_EpQG7eiGjykNQmr7CKKz8z2e8KnC` | yes — created 2026-08-26 10:09:02 CDT, `…-muonu0u5r-…` |
| Five cutover env names in Production | absent | **still absent** — production env name enumeration returns only `BLOB_READ_WRITE_TOKEN`, `FAMILY_REVIEW_ADMIN_KEY`, `FAMILY_REVIEW_CODES`, `HSB_PUBLIC_BLOB_BASE` |
| Health | apex `/`, `/family-review`, `/family-review/admin` = 200; `www` 308 → apex | reproduced; `/checkout` also 200 |

### 3.1 Correction: the apex is not serving current main

The evidence packet records the apex as bound to `dpl_EpQG7…`. That is
correct, and its consequence is larger than the packet states: **the
production domain is serving pre-#157 code, which is therefore also
pre-#160.** Two independent read-only probes:

1. **Header marker (#157).** #157 added `X-Content-Type-Options: nosniff`
   to `/family-review`. `https://herostorybooks.com/family-review` does
   **not** send it. `dpl_75oz…/family-review` does. `dpl_EpQG7…/family-review`
   does not.
2. **Bundle marker (#160).** #160 introduced the
   `data-testid="stripe-handoff-fallback"` manual-link element. The string
   is absent from every `/_next/static/**.js` chunk referenced by
   `https://herostorybooks.com/checkout`, and present in the corresponding
   chunk on `dpl_75oz…`.

So the 2026-08-26 23:55 CDT checkout incident fix is built and READY but
**not live for customers**. That is an independent, higher-urgency finding
than the storage cutover, and it belongs to a separate promotion decision
(Gate C in the runbook) rather than to this packet.

## 4. BLOCKER — the runtime has no way to address the private destination store

This is the defect that stops the cutover. It is a property of the
merged code, not of the drift.

### 4.1 What the code actually does

Every runtime Family Review blob call resolves its store from the
**ambient, app-wide `BLOB_READ_WRITE_TOKEN`**:

- `src/lib/family-review/private-assets.ts` — `put`, `get`, `head`, `del`
  are called with no `token:` option.
- `src/lib/family-review/store.ts` — `put` (lines 391, 398) and `list`
  (line 492) are called with no `token:` option; `hasBlobToken()` reads
  `process.env.BLOB_READ_WRITE_TOKEN` directly (line 223).

A repository-wide grep finds **no runtime code that reads
`FAMILY_REVIEW_DEST_BLOB_TOKEN` or `FAMILY_REVIEW_SOURCE_BLOB_TOKEN`**.
Both appear only in `scripts/family-review-migrate-assets.ts` and its
tests. The rollout doc says so itself (§10 table: "never read by the
app").

Meanwhile the migration writes its output — assets **and** the submission
records **and** the review-token index — exclusively into the destination
store under `token: creds.destToken`
(`scripts/family-review-migrate-assets.ts:1253-1281`, `writeDestinationRecord`), and never writes to
the source store at all.

### 4.2 What that means for the three authorized steps

Execute the approval exactly as written — add the five names, run
dry-run, run apply, flip `FAMILY_REVIEW_BLOB_ACCESS=private` — and this
is the result:

1. **The migration achieves nothing observable.** The app keeps reading
   the *source* store, whose records the migration never modified. They
   still carry `storage: 'public'` and a populated `blobUrl`, so every
   read continues to go out over the legacy public URL. The public-object
   exposure the cutover exists to close **stays open**. The verified
   private copies are invisible to the application.
2. **New uploads break.** With `FAMILY_REVIEW_BLOB_ACCESS=private`,
   `putAsset` issues `put(…, { access: 'private' })` against the store
   `BLOB_READ_WRITE_TOKEN` names — which is the **public** production
   store. Vercel rejects it (`Cannot use private access on a public
   store`), the module fails closed by design, and the upload route
   returns 502. Parent reference-photo upload and admin sample upload
   both stop working. Fail-closed, not a leak — but a live customer-facing
   break with no compensating benefit.
3. **Admin listing changes read path with no store behind it.**
   `listSubmissions` switches to `fetchSubmissionByPath` whenever
   `familyReviewAssetStorageMode() === 'private'`, i.e. on the same flag,
   against the same wrong store.

The approval's pass criterion *"metadata records contain `storage:
'private'` and no `blobUrl` after verified persistence"* would be
satisfied — in a store nothing reads.

### 4.3 The action that would make it work is out of scope and destructive

The design's own text is consistent about the intended mechanism: §8
rollback step 1 is *"point the deployment's `BLOB_READ_WRITE_TOKEN` back
at the **source** store"*, and residual risk 8 is *"keep the app pointed
at the source during cutover."* The runtime flip is a
`BLOB_READ_WRITE_TOKEN` repoint.

Two problems with that.

**First, it is a sixth variable.** `BLOB_READ_WRITE_TOKEN` is not one of
the five approved names, and the approval's hard exclusions bar "unrelated
Production env/config changes." Repointing it is not covered by the
approval phrase and cannot be read into it.

**Second, and decisively: `BLOB_READ_WRITE_TOKEN` is not the Family
Review lane's token. It is the whole application's token.** Every
namespaced prefix written under it:

| Prefix | Owner | Copied by the migration? |
|---|---|---|
| `family-review/submissions/*.json` | Family Review | **yes** |
| `family-review/review-tokens/*.json` | Family Review | **yes** |
| `orders/<id>.json` | order records | **no** |
| `orders/<id>/photo-*` | customer photos | **no** |
| `orders/<id>/*voice-*` | customer voice notes | **no** |
| `payment-recovery/*.json` | payment recovery | **no** |
| `recovery/*.json` | order recovery | **no** |

The migration enumerates one prefix — `{namespace}/family-review/submissions/`
(`scripts/family-review-migrate-assets.ts:1082`). Repointing
`BLOB_READ_WRITE_TOKEN` at the private destination store would leave
every order record, customer photo, voice note, and recovery record
behind in the source store, in a store the app is no longer looking at.
`src/lib/orders.ts` fails closed on a missing object in production, so the
visible outcome is order reads, status pages, fulfillment, and payment
recovery erroring out — for the entire order book, to close a Family
Review exposure.

### 4.4 Why this is a stop, not a workaround

There is no operator sequencing that avoids it. The three shapes are:

- **Migrate but do not flip** — safe, and pointless: exposure unchanged
  (§4.2.1). It also leaves a second store holding a full duplicate copy
  of every child photo and family record, which *increases* the number of
  places that data exists while closing nothing.
- **Flip `FAMILY_REVIEW_BLOB_ACCESS` only** — breaks uploads, closes
  nothing (§4.2.2).
- **Flip `BLOB_READ_WRITE_TOKEN`** — closes the Family Review exposure and
  takes the order lane down with it (§4.3).

Closing this properly requires a code change: the Family Review storage
boundary must accept an explicit store credential of its own, so the lane
can be pointed at the private store while `orders/*`, `payment-recovery/*`,
and `recovery/*` stay on the existing one. That is implementation work
under a new task, not something to be decided inside a cutover window.
Per the packet's own instruction, this review stops here rather than
expanding into it.

## 5. What was verified as sound

The blocker is about *deployability*, not about the merged code's quality.
Everything below held up under review:

- Two-credential design with no ambient fallback, and store-id (not
  string) aliasing detection — the P0 that §6.2 exists to prevent is
  genuinely prevented.
- Dry-run default; three-part confirmation to write.
- Streamed copy with hash-and-count metering and an abort ceiling; content
  type sniffed from destination bytes, not echoed.
- Checkpoint binding to `{kind, assetId, pathname, size, mime, sourceSha256}`
  with revalidation, so a resumed run cannot skip an asset whose bytes moved.
- Fail-closed private read/write with no public retry and no Blob URL to
  the client.
- Migration never deletes, never writes to source, never enumerates the
  destination.
- PR #160's fail-closed exact-host allowlist (rejects credential-embedding
  and lookalike hosts), navigate-before-cleanup ordering, and ref-backed
  submit lock.

## 6. Test receipt

All runs against `f795a9d5…` in the isolated worktree. Node v24.18.0,
Next 16.2.0, `@vercel/blob` 2.3.3, Playwright 1.62.1. Deps via `npm ci`
(247 packages).

| Command | Result |
|---|---|
| `npm test` | **1784/1784 pass**, 0 fail (85.7 s) |
| `npm run build` | **✓ Compiled successfully in 19.6 s**; full route manifest emitted |
| `npx playwright test` | **119/119 pass** (3.0 min), desktop-chromium + mobile-chromium |
| `npx playwright test tests/e2e/checkout-stripe-handoff.spec.ts tests/e2e/checkout-stripe-handoff.mobile.spec.ts` | **9/9 pass** |
| `npm run lint` | **not run** — `eslint` is not an installed dependency (`sh: eslint: command not found`). Pre-existing; §13 of the #157 doc records the same gap. |

Focused suites, both lanes green side by side on the same tree:

| Suite | Tests |
|---|---|
| `family-review-private-assets` | 12/12 |
| `family-review-asset-access-control` | 17/17 |
| `family-review-asset-migration` | 103/103 |
| `family-review-privacy` | 33/33 |
| `family-review-image-type` | 6/6 |
| `checkout-stripe-handoff` | 19/19 |
| `payment-recovery-contract` | 4/4 |

The Playwright config is hermetic by construction: `BLOB_READ_WRITE_TOKEN`,
`STRIPE_SECRET_KEY`, `HSB_STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `FAL_KEY`,
`GEMINI_API_KEY`, `LULU_CLIENT_*`, `OPENAI_API_KEY` are blanked and the
order store is redirected to a local throwaway directory, so no test could
reach a production order, store, mailbox, or payment.

## 7. Residual risks not closed by this review

1. **Untested store boundary.** The #157 Preview soak stopped before any
   destination write. No two-store copy has run end to end anywhere. Even
   with §4 resolved, the first real exercise must be Preview, not
   Production.
2. **Backup prerequisite.** Still an external hard gate. Nothing in this
   review verified it, and nothing here should be read as clearing it.
3. **Legacy URLs already handed out** stay valid until a separate
   reclamation pass, and edge caches may hold copies ~1 year (F-1). The
   cutover reduces new exposure; it does not revoke old URLs.
4. **Apex is on pre-#157/#160 code** (§3.1). Until that is promoted, both
   the privacy hardening and the checkout incident fix are inert for
   customers.
5. **`useCache`-on-public sites in `src/lib/orders.ts`** remain untriaged
   (#157 residual risk 6).
6. **Duplicate copy of child photos** if a migration is run without a
   runtime flip (§4.4).

## 8. Prohibited-action confirmation

None of the following occurred at any point in this task: Production or
Preview deployment; promotion; alias change; environment variable
creation, mutation, deletion, or secret-value read; Blob store
provisioning; migration dry-run or apply against any store; merge; public
release; legacy-source deletion or reclamation; customer, order, payment,
refund, proof, fulfillment, print, or provider action; outreach, post, or
send. No existing worktree or dirty branch was touched. Read-only Vercel
CLI calls were limited to `ls --prod`, `inspect`, `env ls production`
(names only), and `whoami`; read-only HTTP was limited to unauthenticated
`GET`/header reads of public URLs.
