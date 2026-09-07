// Some HSB routes carry bearer-like material in the URL. `/status/<orderId>`
// and `/review/<orderId>` identify an order to anyone holding the link, and
// those links are emailed out and then re-shared with `?email=<buyer>` or
// `?token=<approval>` appended. None of that may reach an analytics vendor, so
// every analytics surface publishes the route template instead of the concrete
// path, and never the query string or the fragment.
//
// Shared by the runtime analytics layer (`src/lib/analytics.ts`) and the inline
// gtag bootstrap in the root layout, which runs before any module loads and so
// gets the same table serialized into it.

export type IdentifierRoute = {
  /** Path pattern where `*` matches exactly one non-empty segment. */
  pattern: string;
  /** What analytics sees in place of a matching path. */
  template: string;
};

// Most specific first: the family-review image route extends the
// family-review token route.
export const IDENTIFIER_ROUTES: readonly IdentifierRoute[] = [
  {
    pattern: '/family-review/review/*/image/*',
    template: '/family-review/review/[reviewToken]/image/[assetId]',
  },
  { pattern: '/family-review/review/*', template: '/family-review/review/[reviewToken]' },
  { pattern: '/status/*', template: '/status/[orderId]' },
  { pattern: '/review/*', template: '/review/[orderId]' },
  { pattern: '/admin/orders/*', template: '/admin/orders/[orderId]' },
];

function stripQueryAndFragment(path: string): string {
  return path.split('?')[0].split('#')[0];
}

function matchesPattern(segments: string[], pattern: string): boolean {
  const patternSegments = pattern.split('/');
  if (segments.length < patternSegments.length) return false;
  return patternSegments.every((segment, i) =>
    segment === '*' ? segments[i].length > 0 : segments[i] === segment,
  );
}

/**
 * Collapse a URL path to a shape that is safe to publish. Identifier-bearing
 * routes become their template; every other route keeps its path, minus any
 * query string and fragment. Already-collapsed templates are unchanged.
 */
export function sanitizeAnalyticsPath(path: string): string {
  const pathOnly = stripQueryAndFragment(path);
  const segments = pathOnly.split('/');
  const match = IDENTIFIER_ROUTES.find((route) => matchesPattern(segments, route.pattern));
  return match ? match.template : pathOnly;
}

/** The same rule for an absolute URL, dropping everything after the path. */
export function sanitizeAnalyticsUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${sanitizeAnalyticsPath(url.pathname)}`;
  } catch {
    return sanitizeAnalyticsPath(href);
  }
}

/**
 * Redact a Vercel Analytics event URL. Vercel's `beforeSend` hook sees both the
 * component's automatic page views and the custom events forwarded by track(),
 * and the event URL is a full URL — so stripping the query string alone would
 * still ship the bearer segment in the path. Relative URLs resolve against the
 * current origin; an unparseable one falls back to the current location, which
 * is redacted too.
 */
export function sanitizeVercelAnalyticsUrl(
  rawUrl: string,
  currentOrigin: string,
  currentPathname: string,
): string {
  try {
    const url = new URL(rawUrl, currentOrigin);
    return `${url.origin}${sanitizeAnalyticsPath(url.pathname)}`;
  } catch {
    return `${currentOrigin}${sanitizeAnalyticsPath(currentPathname)}`;
  }
}

/**
 * The same rule as an inline ES5 snippet, for the root layout's
 * `beforeInteractive` gtag bootstrap. It defines `hsbSafePath` from the table
 * above so the inline copy cannot drift from the module one.
 */
export function analyticsPathBootstrapScript(): string {
  const table = IDENTIFIER_ROUTES.map((route) => [route.pattern.split('/'), route.template]);
  return `
var hsbIdRoutes = ${JSON.stringify(table)};
function hsbSafePath(path) {
  var segments = String(path == null ? '' : path).split('?')[0].split('#')[0].split('/');
  for (var i = 0; i < hsbIdRoutes.length; i++) {
    var pattern = hsbIdRoutes[i][0];
    if (segments.length < pattern.length) continue;
    var matched = true;
    for (var j = 0; j < pattern.length && matched; j++) {
      matched = pattern[j] === '*' ? segments[j].length > 0 : segments[j] === pattern[j];
    }
    if (matched) return hsbIdRoutes[i][1];
  }
  return segments.join('/');
}`.trim();
}
