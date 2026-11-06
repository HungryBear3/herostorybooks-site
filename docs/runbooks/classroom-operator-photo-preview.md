# Classroom operator photo preview

Status: source implemented and locally tested with synthetic bytes. **Nothing
below has been executed on a hosted deployment.** This does not open intake,
export, order, print or generation, and it does not make the room-parent
invitation sendable. Report NOT READY TO SEND until the checks below have
evidence.

## What it does

- `GET /api/admin/group-book/review?cohortId=<id>` still reads metadata only. It
  adds one `Preview N` link per proven eligible asset and reads no photo object.
- `GET /api/admin/group-book/photo?cohortId=<id>&submissionId=<gbs_>&assetId=<gbp_>`
  returns one private JPEG. It accepts exactly those three identifiers.
- Admin credential first (`hsb-ops-key` cookie or existing admin header). Guardian
  sessions and invitation codes are never accepted.
- Every request rechecks the whole cohort's admission (roster, withdrawal,
  revocation, adopted policy stamp, edition), invitation expiry, durable purpose
  against configuration and the record's stamp, the retention anchor, and the
  asset against the current record. It rechecks the family and edition again
  after the read.
- `404 photo_unavailable` is a proven refusal. `503 photo_held` is uncertainty.
  Neither says which check refused.

## Reading the result

| Situation | Result |
| --- | --- |
| Any family in the cohort unreadable, unverified, revoked with a submission, or outside the adopted policy | Whole cohort held, no links |
| Family withdrawn | That family refused; others unchanged. OMIT is not deletion |
| Invitation expired | That family refused until the operator reissues access |
| First final release or delivery recorded | Held, no links, even inside the 90 days |
| 90 days after authoritative delivery, or pilot closed | Refused, even if the bytes still exist |
| No durable purpose marker | Held. Historical cohorts without a marker are not previewable |

A refused photo may still exist in storage. A refusal is not deletion evidence.

## Retention facts

- Real `fullbook`: 90 days after the authoritatively recorded final delivery. With
  no recorded delivery, no deletion date exists.
- `pilot_test_only` only: server-recorded pilot close + 7 days. Never assign it to
  a real finished-book cohort.
- Provider-side backups are not claimed erased.

## Remaining hosted checks (each needs its own authority)

Use only the existing HSB Auth, private Blob and admin bindings. No new providers,
stores or credentials. No repeat human privacy pilot.

1. **Binding:** on the accepted target host, confirm the effective runtime has the
   exact source identity, `HSB_ORDER_ADMIN_KEY`, and a
   `GROUP_BOOK_BLOB_READ_WRITE_TOKEN` that names a store distinct from the ordinary
   and Family Review stores. Historical bindings do not carry to a new deployment.
2. **Containment:** `HSB_CLASSROOM_QA_ONLY=true` on Preview refuses this route and
   the review page. Such a host cannot qualify this workflow. Do not weaken the
   guard. Keep `GROUP_BOOK_INTAKE_ENABLED` and `HSB_CLASSROOM_AUTH_ENABLED` off until
   the target is separately authorized.
3. **Operator:** with authorized synthetic or approved data, confirm unauthenticated
   and guardian requests are refused before storage, one link returns one image in a
   browser, the response carries `no-store`, `no-referrer` and `nosniff`, and no
   storage URL appears in the page, response or logs. Confirm a real private Blob
   read classifies present, absent and failure as the fake does: the SDK's
   throw-versus-404 behaviour is unverified in this source.
4. **Withdrawal:** confirm a withdrawn family's link refuses on the next request and
   the other family is unchanged.
5. **Retention:** recover the receipt for cleanup job `4c2467c20b45` (execution is
   UNKNOWN) under separately permitted scope. Capacity, backlog, checkpoint, deadline
   and actual deletion/readback evidence remain unproven. Closed hosts and OMIT do
   not prove deletion.
