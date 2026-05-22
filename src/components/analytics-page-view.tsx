"use client";

import { useEffect, useRef } from "react";
import { trackPageView } from "@/lib/analytics";

/**
 * Fires the `page_view` HSB analytics event exactly once per mount.
 *
 * Wire it from a server component (page.tsx or a shared shell) and it
 * pushes via the vendor-free analytics layer (`window.dataLayer` +
 * `window.hsbEvents`). Safe with React strict mode — the `useRef`
 * latch prevents the double-mount in dev from causing duplicate
 * events.
 */
export function AnalyticsPageView({ pathname }: { pathname?: string }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    trackPageView(pathname);
  }, [pathname]);
  return null;
}
