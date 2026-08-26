"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { metaHandleRoute } from "@/lib/marketing/meta-bridge";

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

  useEffect(() => {
    if (!pathname || lastPathnameRef.current === pathname) return;
    lastPathnameRef.current = pathname;
    metaHandleRoute(pathname);
  }, [pathname]);

  return null;
}
