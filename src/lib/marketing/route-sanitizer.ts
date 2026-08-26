/**
 * Route sanitisation for ad-platform measurement.
 *
 * Two separate jobs, in this order:
 *
 *  1. SANITISE — drop the query string and fragment. HSB puts real customer
 *     data in both: `/thank-you?...&childName=...&email=...` is built by
 *     src/app/api/order/route.ts, and `/checkout?childName=...` is the
 *     NamePreview handoff. A raw URL must never leave the browser.
 *
 *  2. TEMPLATE — replace dynamic segments with their route parameter name, so
 *     `/status/a1b2c3d4e5f60718` becomes `/status/[orderId]`. An order id is an
 *     identifier; a template is a page.
 *
 * Then a third, stricter step that this file also owns: even a perfectly
 * templated private route is not sent. META_TRACKABLE_ROUTES is a closed
 * allowlist of public funnel pages, and anything outside it produces no Meta
 * behaviour at all — no event, and no script load. That is what keeps the
 * pixel out of /family-review, whose middleware CSP is `default-src 'self'`.
 *
 * Pure and isomorphic.
 */

/**
 * Dynamic route shapes that exist in src/app today, most specific first so the
 * two-segment family-review image route wins over its parent.
 */
const DYNAMIC_ROUTE_RULES: readonly { pattern: RegExp; template: string }[] = [
  { pattern: /^\/family-review\/review\/[^/]+\/image\/[^/]+\/?$/, template: '/family-review/review/[reviewToken]/image/[assetId]' },
  { pattern: /^\/family-review\/review\/[^/]+\/?$/, template: '/family-review/review/[reviewToken]' },
  { pattern: /^\/admin\/orders\/[^/]+\/?$/, template: '/admin/orders/[orderId]' },
  { pattern: /^\/gifts\/[^/]+\/?$/, template: '/gifts/[occasion]' },
  { pattern: /^\/review\/[^/]+\/?$/, template: '/review/[orderId]' },
  { pattern: /^\/status\/[^/]+\/?$/, template: '/status/[orderId]' },
];

/**
 * Public funnel routes the Meta candidate may observe, as templates.
 *
 * Deliberately absent, each for a stated reason:
 *   /thank-you              purchase-adjacent, and its query carries email +
 *                           child name + Stripe session id. Purchase is a
 *                           server-only event; the browser has no business here.
 *   /order, /status/[..]    post-purchase order state.
 *   /review/[orderId]       customer proof surface (private, noindex).
 *   /family-review/*        family privacy surface with a self-only CSP.
 *   /admin/*                operator surface.
 *   /create/your-memory     paid-beta intake behind a server gate.
 *   /privacy, /terms        public but not funnel; tracking them is only noise.
 *   /pricing                a server redirect to /#pricing (src/app/pricing/page.tsx);
 *                           it never renders a page, so listing it would be dead config.
 */
export const META_TRACKABLE_ROUTES: readonly string[] = [
  '/',
  '/about',
  '/samples',
  '/gifts',
  '/gifts/[occasion]',
  '/checkout',
];

/** Strip query and fragment, collapse duplicate slashes, drop a trailing slash. */
export function stripQueryAndFragment(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return '/';
  let path = raw;
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash);
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);

  // An absolute URL may arrive from a caller that passed location.href.
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(path);
  if (schemeMatch) path = schemeMatch[1] ?? '/';

  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

/** Sanitise then template. Returns a route shape, never an instance. */
export function sanitizeRoute(raw: string): string {
  const path = stripQueryAndFragment(raw);
  for (const rule of DYNAMIC_ROUTE_RULES) {
    if (rule.pattern.test(path)) return rule.template;
  }
  return path;
}

/** True only for a sanitised template on the public funnel allowlist. */
export function isMetaTrackableRoute(sanitized: string): boolean {
  return META_TRACKABLE_ROUTES.includes(sanitized);
}

/**
 * One call for the adapter: sanitise, template, and decide. Returns null when
 * the route must produce no Meta behaviour at all.
 */
export function metaRouteFor(raw: string): string | null {
  const sanitized = sanitizeRoute(raw);
  return isMetaTrackableRoute(sanitized) ? sanitized : null;
}
