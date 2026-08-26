"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { metaHandleRoute } from "@/lib/marketing/meta-bridge";
import { getConsent, subscribeConsent } from "@/lib/marketing/consent-store";

/**
 * Mount point for the Meta Pixel candidate.
 *
 * Mirrors <AnalyticsPageView /> on purpose: same pathname source, same
 * previous-path latch, same "query strings never reach here" property. The
 * latch is the second of two guards — the controller latches routes as well —
 * so a StrictMode double effect cannot produce two initial PageViews.
 *
 * Rendering this is not the same as enabling anything. The bridge returns null
 * unless the public pixel id and the feature flag are both set, and the
 * controller additionally requires granted consent and a public funnel route
 * before it loads a single byte from Meta. On a deployment without those, this
 * component's entire runtime effect is one function call that returns a
 * skip reason.
 */
export function MetaPixelMount() {
  const pathname = usePathname();
  const lastPathnameRef = useRef<string | null>(null);
  const [consent, setConsentState] = useState(() => getConsent());

  // Consent is the shared source of truth, and it can change after this route
  // was already offered. Re-offering the SAME pathname is safe: the controller
  // latches a route only once it has passed every gate, so a route that was
  // skipped for consent has not been latched and will emit exactly one
  // PageView on a grant -- while a route that already emitted one is refused
  // as a duplicate. A decline needs no undo here; the controller's own consent
  // gate stops the next event.
  useEffect(() => subscribeConsent(setConsentState), []);

  useEffect(() => {
    if (!pathname) return;
    if (lastPathnameRef.current === pathname && consent !== "granted") return;
    lastPathnameRef.current = pathname;
    metaHandleRoute(pathname);
  }, [pathname, consent]);

  return null;
}
