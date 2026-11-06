import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { configuredCohorts, openOperatorPhotoPreview, OPERATOR_PHOTO_ASSET_RE } from '@/lib/group-book/operator-photo';
import { GROUP_BOOK_PRIVATE_HEADERS } from '@/lib/group-book/session';
import { groupBookStorageReady } from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COHORT_RE = /^[A-Za-z0-9_-]{3,64}$/;
const SUBMISSION_RE = /^gbs_[A-Za-z0-9_-]{1,64}$/;
const QUERY_KEYS = 'assetId,cohortId,submissionId';
const BASE_HEADERS = { ...GROUP_BOOK_PRIVATE_HEADERS, 'X-Content-Type-Options': 'nosniff' } as const;
const PHOTO_HEADERS = {
  ...BASE_HEADERS,
  'Content-Disposition': 'inline; filename="classroom-photo.jpg"',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
} as const;

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: BASE_HEADERS });
const unavailable = () => refuse(404, 'photo_unavailable');
const held = () => refuse(503, 'photo_held');

/** Exactly the three identifiers, once each: a caller path or URL is never accepted. */
function identifiers(req: Request) {
  const params = new URL(req.url).searchParams;
  if ([...params.keys()].sort().join() !== QUERY_KEYS) return null;
  const cohortId = params.get('cohortId') ?? '';
  const submissionId = params.get('submissionId') ?? '';
  const assetId = params.get('assetId') ?? '';
  if (!COHORT_RE.test(cohortId) || !SUBMISSION_RE.test(submissionId) || !OPERATOR_PHOTO_ASSET_RE.test(assetId)) return null;
  return { cohortId, submissionId, assetId };
}

/**
 * Operator preview of one family photo. Uses the existing admin credential,
 * then rechecks current eligibility on every request before serving bytes from
 * private storage. Read-only, one asset per request: no mutation, listing or
 * export. A proven refusal is a 404; any uncertainty is a generic 503 hold.
 */
export async function GET(req: Request) {
  if (!isAdminAuthedFromRequest(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: BASE_HEADERS });
  }
  const ids = identifiers(req);
  if (!ids) return refuse(400, 'invalid_request');
  const rows = configuredCohorts();
  if (!rows || !groupBookStorageReady()) return held();
  if (!rows.some((row) => row.cohortId === ids.cohortId)) return unavailable();
  try {
    const photo = await openOperatorPhotoPreview({ ...ids, now: Date.now() });
    if (photo.state === 'unavailable') return unavailable();
    if (photo.state === 'held') return held();
    return new Response(new Uint8Array(photo.bytes), {
      status: 200,
      headers: { ...PHOTO_HEADERS, 'Content-Type': photo.mime, 'Content-Length': String(photo.bytes.byteLength) },
    });
  } catch (err) {
    console.error('[group-book/photo] private read failed:', err instanceof Error ? err.name : 'unknown');
    return held();
  }
}
