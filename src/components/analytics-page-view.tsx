"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { deliverGa4PageView } from "@/lib/analytics";
import { getConsent, subscribeConsent } from "@/lib/marketing/consent-store";
import { getAnalyticsCoordinator } from "@/lib/marketing/analytics-coordinator";
import type { ConsentState } from "@/lib/marketing/consent";

/**
 * Asks the coordinator to deliver exactly one sanitized page view per route.
 *
 * All of the hard parts -- the readiness race, the single-slot pending route,
 * the delivered-route latch, cancellation on withdrawal -- live in
 * `analytics-coordinator.ts`, which is testable without a browser. This
 * component only reports two facts: which route is current, and what consent
 * says.
 *
 * The coordinator is a per-tab singleton, so a remount or a React StrictMode
 * double effect re-reports the same route and is absorbed rather than
 * duplicated.
 */
export function AnalyticsPageView() {
  const pathname = usePathname();
  const [consent, setConsentState] = useState<ConsentState>("unknown");
  const coordinatorRef = useRef<ReturnType<typeof getAnalyticsCoordinator> | null>(null);

  if (coordinatorRef.current === null) {
    coordinatorRef.current = getAnalyticsCoordinator({
      emit: (route) => deliverGa4PageView(route),
      consent: () => getConsent(),
    });
  }

  useEffect(() => {
    setConsentState(getConsent());
    return subscribeConsent(setConsentState);
  }, []);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || !pathname) return;
    if (consent !== "granted") {
      // Withdrawal or decline cancels anything waiting on readiness.
      coordinator.cancelPending();
      return;
    }
    coordinator.requestPageView(pathname);
  }, [pathname, consent]);

  return null;
}
