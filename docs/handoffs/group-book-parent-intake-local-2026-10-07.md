# Group-book parent intake — local implementation map

Status: local-only implementation lane. No production activation, invitations,
real uploads, email, payment, provider, proof, print, or distribution authority.

Base: `origin/main` at `baf00cfb0b65f1bca3465ea801a57af3c552f74e`.

## Separation from Family Review

- New parent surface: `/group-book`.
- New API namespace: `/api/group-book/**`.
- New data namespace: `group-book/**` in a dedicated private Blob store.
- New configuration: `GROUP_BOOK_INVITES_JSON` and
  `GROUP_BOOK_BLOB_READ_WRITE_TOKEN`; neither Family Review invite codes nor
  its storage credential are read.
- No Family Review record, route, component state, admin board, or review token
  semantics are changed.

## Exact flow

1. Alexy/HSB creates one high-entropy private invite token per family in a
   server-only cohort configuration. The token maps to one opaque cohort id and
   one opaque family slot id. It is never sent to the browser as configuration.
2. A parent enters that token at `/group-book`. The browser holds the form and
   selected files only in memory; there is no local/session storage draft.
3. The parent can enter details and photos for one child only. The server
   derives cohort/family ownership from the invite token, not from client
   fields.
4. Consent separately confirms guardian authority, use of the child's first
   name/illustrated likeness in the private group book shared with
   participating families, and the explicit statement that no school approval
   is represented or implied. Source photos remain private to HSB operators and
   are not a family gallery.
5. The server validates the invite, consent, field limits, byte signatures,
   count, and size before storage. It writes only to a dedicated private store.
   Original filenames are discarded.
6. The same high-entropy family token is the family's private access
   capability. `/group-book/family/{token}` shows only that family's sanitized
   submission summary. There is no cohort listing and no room-parent/admin
   surface in this lane.
7. Before proof/print, the family can create an append-only withdrawal marker.
   The effective record then becomes `withdrawal_requested` with
   `omitFromProofAndPrint=true`. Any later proof/print integration must check
   this effective state immediately before work; this lane does not connect to
   proof, print, distribution, payment, email, or providers.

## Failure and retry shape

- Missing/malformed dedicated storage credentials fail closed before an SDK
  call.
- An existing family record is returned as `already_submitted` without a new
  upload.
- The family record is create-only. A concurrent loser deletes its newly
  uploaded orphan assets best-effort and resolves to the already-created
  record; it never overwrites another submission.
- Withdrawal markers are create-only and repeated withdrawal is idempotent.
- Parent API misses return 404 rather than distinguishing unknown cohort,
  family, or token.

## Activation gates intentionally left outside this change

- Exact cohort/family invite inventory and high-entropy token generation.
- Legal/copy owner approval for the consent text and retention/deletion policy.
- Dedicated private Blob store provisioning and credential installation.
- Authenticated HSB-operator retrieval, proof assembly, print, and distribution
  workflows, each with a withdrawal recheck.
- Real-parent invitation, upload, email, proof, print, or production deploy.

## Local verification

- New synthetic group-book privacy/storage suite: 6/6 PASS.
- New suite plus existing Family Review privacy/access/token/store suites:
  110/110 PASS.
- Repository-wide unit suite: 4,212/4,212 PASS.
- TypeScript `--noEmit`: PASS.
- Next.js Production build: PASS; routes include `/group-book`,
  `/group-book/family`, and the three `/api/group-book/*` handlers.
- `git diff --check`: PASS.
- No existing `src/app/family-review`, `src/app/api/family-review`, or
  `src/lib/family-review` file changed.
- Verification used only synthetic identities and in-memory fake Blob storage.
