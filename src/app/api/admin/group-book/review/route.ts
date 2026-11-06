import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { invitePurpose } from '@/lib/group-book/config';
import { adminAdmissionView, type FamilyAdmissionStatus } from '@/lib/group-book/export';
import { configuredCohorts, loadOperatorPhotoReview, type ConfiguredCohort } from '@/lib/group-book/operator-photo';
import { loadGroupBookCohortPurpose } from '@/lib/group-book/pilot-retention';
import { groupBookEditionState } from '@/lib/group-book/retention';
import { GROUP_BOOK_PRIVATE_HEADERS } from '@/lib/group-book/session';
import { groupBookStorageReady } from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COHORT_RE = /^[A-Za-z0-9_-]{3,64}$/;
const REVIEW_PATH = '/api/admin/group-book/review';
const PHOTO_PATH = '/api/admin/group-book/photo';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const HTML_HEADERS = {
  ...GROUP_BOOK_PRIVATE_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

const STATUS_LABELS: Record<FamilyAdmissionStatus, string> = {
  eligible: 'ELIGIBLE',
  not_submitted: 'NOT SUBMITTED',
  withdrawn: 'OMIT: guardian withdrew. Leave out of proof and print. Not a deletion record.',
  invite_revoked: 'EXCLUDED: invitation revoked',
  invite_revoked_with_submission: 'HELD: invitation revoked with a submission on file',
  unreadable: 'HELD: record unreadable',
  withdrawal_unverified: 'HELD: withdrawal unverified, treat as omitted',
  policy_unstamped: 'HELD: consent has no policy stamp',
  policy_mismatch: 'HELD: consent does not match adopted policy',
  edition_already_released: 'HELD: edition already released',
};

type ReviewView = ReturnType<typeof adminAdmissionView>;
type PreviewAssets = Map<string, string[]>;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(status: number, content: string, rows: ConfiguredCohort[] | null, selected = ''): Response {
  const options = [...new Set((rows ?? []).map((row) => row.cohortId))].sort()
    .map((cohortId) => `<option value="${escapeHtml(cohortId)}"></option>`).join('');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Classroom submission review</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:24px auto;max-width:960px;padding:0 16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px 8px;text-align:left;overflow-wrap:anywhere}</style>
</head>
<body>
<h1>Classroom submission review</h1>
<p>Read-only. Room parents only pass on the invitation you provision; guardians use <a href="/group-book/sign-in">sign-in</a> and <a href="/group-book">family intake</a>. Export, order and generation stay on hold.</p>
<form method="get" action="${REVIEW_PATH}"><label>Cohort <input name="cohortId" list="cohorts" required pattern="[A-Za-z0-9_\\-]{3,64}" value="${escapeHtml(selected)}"></label><datalist id="cohorts">${options}</datalist> <button type="submit">Review</button></form>
${content}
</body>
</html>
`;
  return new Response(html, { status, headers: HTML_HEADERS });
}

function held(status: number, message: string, rows: ConfiguredCohort[] | null, selected = ''): Response {
  return page(status, `<p role="alert">REVIEW HELD: ${escapeHtml(message)}</p>`, rows, selected);
}

/** One link per proven eligible asset; identifiers only, never a storage path or URL. */
function previewLinks(cohortId: string, submissionId: string, assetIds: string[]): string {
  return assetIds.map((assetId, index) => {
    const href = `${PHOTO_PATH}?${new URLSearchParams({ cohortId, submissionId, assetId })}`;
    return ` <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Preview ${index + 1}</a>`;
  }).join('');
}

function reviewContent(view: ReviewView, purpose: string, edition: string, previews: PreviewAssets): string {
  const submissions = new Map(view.eligible.map((row) => [row.familySlotId, row]));
  const rows = view.families.map((family) => {
    const submission = submissions.get(family.familySlotId);
    const label = family.status === 'eligible' && view.state !== 'ready' ? 'HELD: waiting on the rest of the cohort' : STATUS_LABELS[family.status];
    return `<tr><td>${escapeHtml(family.familySlotId)}</td><td>${escapeHtml(label)}</td>` +
      `<td>${submission ? escapeHtml(submission.submissionId) : ''}</td><td>${submission ? `photosHeld: ${submission.photoCount}${previewLinks(view.cohortId, submission.submissionId, previews.get(submission.submissionId) ?? [])}` : ''}</td></tr>`;
  }).join('\n');
  return `<h2>${escapeHtml(view.cohortId)}</h2>
<p>Admission: ${escapeHtml(view.state)}. Purpose: ${escapeHtml(purpose)}. Edition: ${escapeHtml(edition)}.</p>
${view.state === 'ready' ? '' : '<p role="alert">REVIEW HELD: roster or a family record is uncertain or empty. Nobody is eligible until it settles.</p>'}
<p data-photos-held="true">photosHeld: true. This page reads no family photo and exports nothing. A Preview link opens one private photo and rechecks eligibility on every request; no link means that photo is not proven eligible for preview. Metadata review is not photo readiness.</p>
<table>
<thead><tr><th>Family slot</th><th>Status</th><th>Submission</th><th>Photos</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/**
 * Current metadata and proven preview assets for one cohort, or null when a
 * durable purpose or edition cannot be proven. Reads only private JSON records;
 * never a photo object.
 */
async function loadReview(cohortId: string, rows: ConfiguredCohort[]) {
  const purpose = await loadGroupBookCohortPurpose(cohortId);
  if (purpose.state === 'unknown') return null;
  if (purpose.state === 'registered' && rows.some((row) => invitePurpose(row) !== purpose.record.purpose)) return null;
  const edition = await groupBookEditionState(cohortId);
  if (edition === 'unknown') return null;
  const { admission, previews } = await loadOperatorPhotoReview(cohortId, Date.now());
  const assets: PreviewAssets = new Map([...(previews ?? [])].map(([id, family]) => [id, family.assets.map((asset) => asset.assetId)]));
  return { view: adminAdmissionView(admission), edition, assets, purpose: purpose.state === 'registered' ? purpose.record.purpose : 'none recorded' };
}

/**
 * Operator review of classroom submissions. Uses the existing admin credential
 * and existing admission projection, then stops: no mutation, photo read, raw
 * media, CSV or export; photos open one at a time through the photo route. Any
 * uncertainty answers a generic 503 hold.
 */
export async function GET(req: Request) {
  if (!isAdminAuthedFromRequest(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: GROUP_BOOK_PRIVATE_HEADERS });
  }
  const values = new URL(req.url).searchParams.getAll('cohortId');
  const rows = configuredCohorts();
  if (values.length === 0) return page(200, '', rows);
  const cohortId = values.length === 1 ? values[0] : undefined;
  if (typeof cohortId !== 'string' || !COHORT_RE.test(cohortId)) return held(400, 'invalid cohort.', rows);
  if (!rows) return held(503, 'cohort configuration is unavailable.', rows);
  if (!groupBookStorageReady()) return held(503, 'private storage is unavailable.', rows);
  const own = rows.filter((row) => row.cohortId === cohortId);
  if (own.length === 0) return held(404, 'cohort not found.', rows);
  try {
    const review = await loadReview(cohortId, own);
    if (!review) return held(503, 'cohort purpose or edition could not be confirmed.', rows, cohortId);
    return page(review.view.state === 'ready' ? 200 : 503, reviewContent(review.view, review.purpose, review.edition, review.assets), rows, cohortId);
  } catch (err) {
    console.error('[group-book/review] private record read failed:', err instanceof Error ? err.name : 'unknown');
    return held(503, 'private records could not be read.', rows, cohortId);
  }
}
