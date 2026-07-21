"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackPageView } from "@/lib/analytics";

/**
 * Fires one sanitized `page_view` HSB analytics event per pathname.
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
    trackPageView(pathname);
  }, [pathname]);
  return null;
}
