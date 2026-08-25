/**
 * GET /api/public/v1/catalog — the versioned public fact contract.
 *
 * Read-only and fully static: the body is serialized once at module load from
 * PUBLIC_CATALOG and never varies by request, cookie, query string, header, or
 * clock. There is deliberately no POST/PUT/PATCH/DELETE handler, so Next's
 * router answers every other method with 405 and an `Allow: GET` header.
 *
 * The request object is intentionally never read. Reading it would opt this
 * route out of static rendering and would make "the same bytes for everyone"
 * an assertion rather than a property of the code.
 */
import { createHash } from 'node:crypto';
import { PUBLIC_CATALOG } from '../../../../../lib/public-catalog.ts';

export const dynamic = 'force-static';

/** Stable, pretty-printed so a human reading the raw endpoint can audit it. */
const BODY = `${JSON.stringify(PUBLIC_CATALOG, null, 2)}\n`;

const ETAG = `"${createHash('sha256').update(BODY).digest('hex').slice(0, 32)}"`;

export function GET(): Response {
  return new Response(BODY, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
      ETag: ETAG,
    },
  });
}
