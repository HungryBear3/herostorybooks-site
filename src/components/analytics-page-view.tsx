"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackPageView } from "@/lib/analytics";
import { recordBrowserAttributionLanding } from "@/lib/attribution-contract";

/**
 * Fires one sanitized `page_view` HSB analytics event per pathname, and records
 * the landing through the bounded attribution contract (UTM fields and a route
 * template only — nothing else from the URL is kept).
 *
 * Mounted once from the root layout. Query strings are deliberately excluded
 * so checkout-prefill values such as childName never reach analytics.
 * The previous-path latch also prevents React strict-mode duplicates.
 */
export function AnalyticsPageView() {
  const pathname = usePathname();
  const lastPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || lastPathnameRef.current === pathname) return;
    lastPathnameRef.current = pathname;
    recordBrowserAttributionLanding();
    trackPageView(pathname);
  }, [pathname]);
  return null;
}
