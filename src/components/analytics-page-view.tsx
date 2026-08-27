"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { trackPageView } from "@/lib/analytics";
import { getConsent, subscribeConsent } from "@/lib/marketing/consent-store";
import type { ConsentState } from "@/lib/marketing/consent";

/**
 * Fires exactly one sanitized `page_view` per route transition, and only while
 * consent is granted.
 *
 * THE LATCH RULE. The previous version latched the pathname unconditionally,
 * which meant a route seen before consent was consumed: granting consent while
 * standing on that page produced no page view at all, because the latch already
 * held it. The latch is now only written after a page view is actually emitted,
 * so:
 *
 *   - before a grant, nothing is latched and nothing is emitted;
 *   - on a grant, the CURRENT route emits exactly one page view;
 *   - each later navigation emits exactly one;
 *   - on withdrawal, nothing more is emitted;
 *   - on a later re-grant, the CURRENT route emits one page view — not a
 *     backlog of the routes visited while denied, which were never queued.
 *
 * Query strings and fragments are dropped and dynamic segments are templated
 * by `trackPageView`, so an order id or a review token can never be the route.
 * The latch also absorbs React StrictMode's double effect.
 */
export function AnalyticsPageView() {
  const pathname = usePathname();
  const lastEmittedRef = useRef<string | null>(null);
  const [consent, setConsentState] = useState<ConsentState>("unknown");

  useEffect(() => {
    setConsentState(getConsent());
    return subscribeConsent(setConsentState);
  }, []);

  useEffect(() => {
    if (!pathname) return;
    if (consent !== "granted") return;
    if (lastEmittedRef.current === pathname) return;
    lastEmittedRef.current = pathname;
    trackPageView(pathname);
  }, [pathname, consent]);

  return null;
}
