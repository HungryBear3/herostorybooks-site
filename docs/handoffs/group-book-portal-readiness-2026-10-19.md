# Group-book portal readiness slice (2026-10-19, local, uncommitted)

Status: engineering slice only. Intake stays CLOSED. No owner policy has been
adopted; no resource, credential, invite, record, deploy or provider call was
made. Synthetic in-memory storage only; NOT provider qualification.

## Server controls

- `GROUP_BOOK_INTAKE_ENABLED` (`src/lib/group-book/release.ts`): only the exact
  string `true` opens NEW persistence. Checked after the existing-record read,
  so a valid capability can still recover, read and withdraw existing work.
- `GROUP_BOOK_POLICY_ADOPTIONS_JSON`: JSON array of owner adoption records
  `{version, adoptedAt, adoptedBy, finishedBookRecipients, withdrawalCutoff,
  sourcePhotoRetention, depictedAdultPermission, guardianReviewScope,
  wholeBookApproval}`; unknown keys, empty text, duplicate versions refuse.
  Missing/malformed => `policy_not_adopted`, intake closed. No defaults exist.
  Each submission (schema 2) stamps `{policy.version, policy.digest}`, the
  server `agreedAt`, and `actor: invite_capability_holder_self_attested`. The
  client must echo the digest it displayed; a mismatch is `policy_consent_stale`.
  Editing an adopted version changes its digest and blocks export admission
  of every submission stamped with the old one (`policy_mismatch`).
- Invites (`GROUP_BOOK_INVITES_JSON`) now REQUIRE `expiresAt` and accept
  optional `revokedAt`. Expired/revoked capabilities get `invite_expired` /
  `invite_revoked` everywhere (access, intake, family page, withdrawal).
  Cookie Max-Age = min(45 days, time to expiry); every request re-resolves.
  Tokens are bare-paste only (URL-shaped input is not mined for a token).
- Withdrawal after invite expiry is refused: whether a post-expiry withdrawal
  path should exist is an OWNER decision tied to the withdrawal cutoff.

## Photos

- Browser always decodes and re-encodes to JPEG (≤1600px, ≤800,000 bytes per
  photo, quality fallback), never uploads the original file. Accept list and
  copy: JPG/PNG/WEBP only; HEIC is not advertised.
- Server: request `content-length` > 4,200,000 => 413 `request_too_large`
  before parsing (Vercel's own 4.5 MB limit may answer first with a non-JSON
  413; the client treats any 413 as "nothing was saved"). Per-file > 800,000
  => 413. Server decode/re-encode unchanged.
- Durable owner first: `group-book/attempts/<familyKey>/<attemptId>.json`
  (create-only) lists every photo path the attempt may write, BEFORE any photo
  write. Owner failure => 503 `owner_record_unconfirmed`, no photo written.
- `@vercel/blob@2.3.3` `requestApi` retries network errors and 5xx up to
  `VERCEL_BLOB_RETRIES` (default 10) with the same body. All writes are
  create-only, so a retried committed write surfaces as an error, never as a
  second object; the family record is then reconciled by reread
  (`createOrReconcileGroupBookSubmission`). Handlers add no retry of their own.
- No deletion promise: withdrawal (OMIT) retains the record and photos and the
  family keeps reading them. Best-effort deletes remain only for photos of a
  failed attempt that no family record references.

## Operator export (`POST /api/admin/group-book/export`)

Existing admin auth (`isAdminAuthedFromRequest`). Loads every configured slot
in the cohort, classifies current effective state, admits only provably
eligible families, and blocks the whole cohort on any uncertainty. Then it
returns 503 `GROUP_BOOK_EXPORT_HOLD` / `no_group_book_artifact_producer`.
`assembleGroupBookExport` snapshots and rechecks exact participation before
calling a publisher, but the recheck is NOT atomic with publication (no
multi-object transaction/CAS in Blob), and no production publisher exists.
Export therefore stays globally HOLD.

## v2: adopted owner policy and retention (2026-10-19)

- `GROUP_BOOK_POLICY_ADOPTIONS_JSON` is removed. The adopted record
  `hsb-classroom-submission-policy-2026-10-19-v1` (owner Alexy Kaplun, decision
  file sha256 `57cedae1…4a21`) is pinned in `release.ts`. Each text begins with
  the owner's exact answer. Changing it requires a code change, and editing it
  blocks export of submissions stamped with the old digest.
- Final delivery: `POST /api/admin/group-book/delivery`
  `{cohortId, recordedBy, evidence}`. Requires existing admin auth. The
  delivery time IS the server recording time; a body carrying `deliveredAt`
  (or any lifecycle time) is refused with 422 `caller_time_rejected`, so it
  cannot be backdated. Create-only and immutable (an identical replay returns
  `replayed`, a different one returns 409); reconciles by reread.
  `dueAt = server delivery time + 90 days`. With no recorded delivery there is
  no due date. Record delivery promptly: a late recording delays deletion, never
  advances it.
- Scheduled cleanup: `GET /api/cron/group-book-retention-sweep` (daily, Vercel
  Cron, `CRON_SECRET`). Discovers cohorts from durable delivery records and
  re-runs the cleanup below for every due cohort on EVERY run, indefinitely,
  so a late provider commit at an owned key is removed by the next run. See
  the successor DESIGN for the SLA; an absolute deletion guarantee is not
  claimed.
- Cleanup: `POST /api/admin/group-book/retention-cleanup {cohortId}`. Server
  clock only. Before the due date it returns `not_due` and deletes nothing. At
  or after the due date it deletes exactly
  `group-book/photos/<familyKey>/gbp_*.jpg`, gathered from the record, the
  family's own attempt records, and a prefix listing. Then it verifies every
  path by reread and writes a create-only receipt. A partial or ambiguous
  delete reports `partial`/`unverified` and reconciles on replay. Foreign,
  look-alike and nested paths are never deleted. Summaries, consent,
  withdrawal markers, attempt, delivery and receipt records are preserved.
  Provider backups are not claimed erased.
- `openGroupBookSourcePhoto` fails closed (`expired`) at the due date even
  before cleanup runs, and returns `unknown` when the delivery record is
  unreadable. The family page explains when photos are unavailable.
- Withdrawal after a recorded final delivery returns 409
  `edition_already_released`; released copies are not recalled. An earlier
  withdrawal stays recorded. Export admission blocks once a delivery exists.
- Client: an ambiguous save marks the whole operation unresolved. Further
  submits go back through the invite check (recovery first), and the invite is
  kept. Refusals and 413s speak only for the current attempt.

## v3: REVIEW-1 remediation (2026-10-19)

- **Cleanup scope is durable, not config.** `discoverCohortFamilies` lists
  `group-book/families/`, `attempts/` and `photos/`, with a hard bound of 50
  pages. Each object must resolve to an exact cohort/family identity whose
  sha256 equals its storage key.
  - Attempt records now carry `cohortId` and `familySlotId`.
  - Removed, expired, revoked and malformed-config slots are still purged.
  - Unreadable, malformed or unowned objects, or listing past the bound,
    return `scope_unknown` (503) and nothing is deleted.
- **No new intake once the edition is released or delivered, or its state is
  unknown.** Intake returns 409 `edition_already_released` or 503. Recovery of
  existing work still happens first.
  - The check runs again right before the family-record commit. A release that
    lands mid-upload refuses the commit, and the photos stay owned by the
    attempt record for the next sweep.
  - There is no transactional fence. Server-recorded times make the earliest
    sweep at least 90 days after the last possible admission, the intake
    writer is bounded (`maxDuration` 60, 45 s write window with abort), and
    the daily sweep re-verifies every declared key. A `complete` sweep is
    still "as of that sweep".
- **First final release.** `POST /api/admin/group-book/final-release`
  `{cohortId, channel: printing|distribution, attribution, evidence}`. The
  release time is the server recording time; `releasedAt` in the body is
  refused (422 `caller_time_rejected`).
  - Create-only, so the first release wins.
  - `recordedVia: shared_admin_session` is bound by the server.
    `attributionUnverified` is operator-entered text, not a proven identity.
  - It is the only withdrawal cutoff. Delivery requires it and cannot precede
    it; delivery is only the retention anchor.
  - It records an out-of-band fact only. No upstream atomic release exists, and
    export/print stay disabled (HOLD).
- **Authorization copy (controller adjudication).** Viewing retained data
  requires a valid invite. Expiry or revocation ends access until the operator
  reissues an invite. Whole-book approval by Alexy, own-child approval and
  depicted-adult consent remain gates before any future producer.
