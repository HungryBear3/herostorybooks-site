/**
 * GET /classroom — information-only classroom page.
 *
 * Serves the owner-approved HTML verbatim as a static document: no layout
 * wrapper, no React, no scripts, no forms. Both calls to action stay disabled;
 * nothing here opens intake. The response CSP mirrors the page's own meta CSP
 * and adds frame-ancestors, which only takes effect as a header.
 */
import { CLASSROOM_HTML } from './classroom-html.ts';

export const dynamic = 'force-static';

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; " +
  "img-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function GET(): Response {
  return new Response(CLASSROOM_HTML, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}
