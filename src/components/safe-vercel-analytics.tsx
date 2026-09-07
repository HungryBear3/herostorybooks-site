"use client";

import { Analytics } from "@vercel/analytics/next";

import { sanitizeVercelAnalyticsUrl } from "@/lib/analytics-path";

/**
 * Vercel Web Analytics wrapper that redacts bearer material from both automatic
 * page views and custom events before they leave the browser: query strings,
 * hashes, and the dynamic path segments of order-status, proof-review, and
 * family-review URLs. On /family-review/review/<token> that path segment is the
 * parent's sole access credential, and the CSP that blocks GA4 there permits
 * this same-origin channel — so the redaction has to happen here.
 */
export function SafeVercelAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => ({
        ...event,
        url: sanitizeVercelAnalyticsUrl(
          event.url,
          window.location.origin,
          window.location.pathname,
        ),
      })}
    />
  );
}
