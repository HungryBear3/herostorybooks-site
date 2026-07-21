"use client";

import { Analytics } from "@vercel/analytics/next";

function sanitizedAnalyticsUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return `${window.location.origin}${window.location.pathname}`;
  }
}

/**
 * Vercel Web Analytics wrapper that strips query strings and hashes from both
 * automatic page views and custom events before they leave the browser.
 */
export function SafeVercelAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => ({
        ...event,
        url: sanitizedAnalyticsUrl(event.url),
      })}
    />
  );
}
