import { NextResponse, type NextRequest } from 'next/server';

import { PUBLIC_CATALOG_ENDPOINT_PATH } from '@/lib/public-catalog';
import { shouldIndexSite } from '@/lib/site-url';
import {
  COVER_VARIANT_COOKIE,
  COVER_VARIANT_COOKIE_MAX_AGE,
  parseVariantCookie,
  pickVariant,
} from '@/lib/cover-variant';

/**
 * Cover-variant cookie + family-review private headers.
 *
 * Two responsibilities now:
 *
 *  1. Existing: sticky cover-variant cookie + x-cover-variant header on
 *     public pages, so server-rendered covers don't flash.
 *
 *  2. The public catalog endpoint is carved out of both. It is the one API
 *     path that exists to be fetched by machines, so it must not receive the
 *     blanket `/api` noindex header on production and must not be handed a
 *     cover-variant cookie it has no use for (a read-only public contract that
 *     sets a cookie is neither cacheable-clean nor honest about being
 *     stateless). Non-production deployments keep the noindex header, so a
 *     preview catalog still cannot be indexed.
 *
 *  3. New (privacy): every response under /family-review/* and
 *     /api/family-review/* gets a tight headers set so the parent's
 *     private review URL, the parent's reference-photo URLs, and the
 *     admin key never leak through referrer/index/script-injection
 *     channels:
 *
 *      - X-Robots-Tag: noindex, nofollow  → search engines won't index
 *      - Referrer-Policy: no-referrer     → nothing leaks to other sites
 *      - X-Content-Type-Options: nosniff  → no MIME second-guessing
 *      - Content-Security-Policy: self-only sources, no frame ancestors
 *      - Permissions-Policy: deny mic/camera/geo for these pages
 *      - X-Frame-Options: DENY            → no iframing
 *
 *     The CSP allows inline scripts/styles ('unsafe-inline') because the
 *     existing portal uses inline event handlers + style="..." attrs;
 *     tightening that is a separate refactor.
 *
 *  4. Referrer containment for the order-bearer customer documents.
 *     `/thank-you` carries orderId + sessionId in its query string, and
 *     `/status/<orderId>` treats the orderId in its path as bearer
 *     authority — holding that URL is enough to see order status, book
 *     format, delivery expectation, tracking number/link and the
 *     customer actions. Both already got `X-Robots-Tag: noindex`, but
 *     noindex only keeps a crawler from listing the URL; it does
 *     nothing about the browser putting that same URL into the
 *     `Referer` header of the page's outbound requests, or into
 *     `document.referrer` for anything the customer clicks through to.
 *     `Referrer-Policy: no-referrer` is the header that closes that,
 *     and it is all these two get: caching, framing and CSP behaviour
 *     are deliberately left exactly as they were.
 */

const FAMILY_REVIEW_PATH = /^\/(?:api\/)?family-review(?:\/|$)/;
const CUSTOMER_REVIEW_PRIVATE_PATH = /^\/(?:review\/|api\/order\/[^/]+\/(?:review|review-session|review-asset\/))/;
const OPERATIONAL_NOINDEX_PATH = /^\/(?:admin|api|checkout|order|partner|review|status|thank-you)(?:\/|$)/;
const ORDER_BEARER_REFERRER_PATH = /^\/(?:status|thank-you)(?:\/|$)/;

const FAMILY_REVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function applyFamilyReviewPrivacyHeaders(response: NextResponse): void {
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  response.headers.set('Referrer-Policy', 'no-referrer');
  // Never let a browser second-guess the declared type of a family
  // asset. The proxies set this too; here it also covers the portal
  // documents themselves.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );
  response.headers.set('Content-Security-Policy', FAMILY_REVIEW_CSP);
  // The proxy routes already set Cache-Control private, but defense in
  // depth — never let a public CDN cache a /family-review response.
  if (!response.headers.has('Cache-Control')) {
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  }
}

function applyNoIndexHeaders(response: NextResponse): void {
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
}

function applyCustomerReviewPrivacyHeaders(response: NextResponse): void {
  applyNoIndexHeaders(response);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (!response.headers.has('Cache-Control')) {
    response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  }
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isFamilyReview = FAMILY_REVIEW_PATH.test(pathname);

  if (isFamilyReview) {
    const response = NextResponse.next();
    applyFamilyReviewPrivacyHeaders(response);
    return response;
  }

  // The public catalog: no cookie, and indexable on production only. Returning
  // early is what keeps the cover-variant assignment below from touching it.
  if (pathname === PUBLIC_CATALOG_ENDPOINT_PATH) {
    const catalogResponse = NextResponse.next();
    if (!shouldIndexSite()) applyNoIndexHeaders(catalogResponse);
    return catalogResponse;
  }

  const response = NextResponse.next();
  if (CUSTOMER_REVIEW_PRIVATE_PATH.test(pathname)) {
    applyCustomerReviewPrivacyHeaders(response);
  }
  if (OPERATIONAL_NOINDEX_PATH.test(pathname)) {
    applyNoIndexHeaders(response);
  }
  // Order-bearer documents: contain the referrer, nothing else. The
  // review paths above already set this to the same value, so the order
  // of these two blocks does not matter.
  if (ORDER_BEARER_REFERRER_PATH.test(pathname)) {
    response.headers.set('Referrer-Policy', 'no-referrer');
  }

  // Preserve the sticky public-page cover variant without allowing the
  // existing-cookie fast path to bypass operational noindex headers.
  const existing = parseVariantCookie(
    request.cookies.get(COVER_VARIANT_COOKIE)?.value,
  );
  if (!existing) {
    const assigned = pickVariant();
    response.cookies.set({
      name: COVER_VARIANT_COOKIE,
      value: assigned,
      maxAge: COVER_VARIANT_COOKIE_MAX_AGE,
      path: '/',
      sameSite: 'lax',
    });
    response.headers.set('x-cover-variant', assigned);
  }
  return response;
}

export const config = {
  // Hit ALL paths (including api routes) so /api/family-review/* gets the
  // privacy headers too. The cover-variant code skips them via the
  // isFamilyReview branch.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|assets|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|xml)).*)',
  ],
};
