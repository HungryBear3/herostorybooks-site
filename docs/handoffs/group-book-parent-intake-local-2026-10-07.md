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
   count, and size before storage, then fully decodes each photo on the server
   and stores only a re-encoded JPEG (see Remediation below). It writes only to
   a dedicated private store. Original filenames are discarded.
6. The same high-entropy family token is the family's private access
   capability. (SUPERSEDED 2026-10-19: tokens are never placed in URLs; the
   bare token is pasted at `/group-book` and held in a `/group-book`-scoped
   HttpOnly cookie; see `group-book-portal-readiness-2026-10-19.md`.)
   `/group-book/family` shows only that family's sanitized
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
- The family record is create-only. A failed create is reconciled against the
  stored record before any cleanup (see Remediation below); it never
  overwrites another submission.
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

## Remediation 2026-10-08 (four reproduced defects; base c3a6ea29)

Status: code changed, NOT_RUN by the author (no execution tools). Real
`@vercel/blob` SDK behaviour: NOT_RUN. Full browser journey: NOT_RUN.

- Withdrawal route: the browser now posts to `/group-book/family/withdraw`
  (`src/app/group-book/family/withdraw/route.ts`, which re-exports the
  existing handler). The access cookie stays at `Path=/group-book`. The old
  `/api/group-book/withdrawal` handler remains; a browser never sends the
  cookie there, so it answers 404.
- Photos: `normalizeGroupBookImage` (`src/lib/group-book/image-type.ts`)
  checks the signature against the declared type, refuses HEIC (the server
  HEIC codec is not qualified), decodes fully with sharp `failOn:'error'`,
  enforces 12,000 px per side, 40 MP and a single frame, applies orientation,
  and stores only re-encoded JPEG bytes. EXIF/XMP/IPTC metadata and trailing
  payloads are not stored. The 10 MiB byte limit (413) and MIME mismatch
  (415) are unchanged. Decode or limit failures return 422 `invalid_image`.
- Private reads: only a 404, an empty result (as in
  `confirmation-envelope-store.ts`) or an instance of the SDK's
  `BlobNotFoundError` (but not `BlobStoreNotFoundError`) counts as absence.
  Any other status, a missing stream, unparseable JSON or a record that fails
  validation or identity checks counts as unreadable. Other thrown errors
  propagate. An unreadable family record refuses with 503
  `storage_unavailable`. An unreadable withdrawal marker yields
  `effectiveStatus: 'withdrawal_unverified'` with omission true, never
  eligible.
- Create: `createOrReconcileGroupBookSubmission` rereads the stored record
  after any create error. If the stored record has our id, every photo is
  kept and the route returns success. If a valid different record is stored,
  only this request's unreferenced photos are deleted. If the result is
  absent, unreadable or thrown, nothing is deleted and the route returns 503
  `record_persist_unconfirmed` with no cookie.
- Not addressed (out of scope): binding the withdrawal marker to a submission
  id, Origin/Sec-Fetch-Site checks, an orphan sweeper, the `rg` test
  dependency, the consent/recipient/cutoff owner decisions.

## Local verification (original 2026-10-07 lane, before remediation)

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
