"use client";

import { useEffect } from "react";
import {
  browserAttributionStorage,
  captureAttribution,
} from "@/lib/marketing/attribution-session";

/**
 * Captures the governed campaign tuple once, at the landing boundary.
 *
 * It reads `window.location.search` directly rather than `useSearchParams`
 * because this must run on the very first paint of the entry URL, before any
 * client navigation has replaced it.
 *
 * ONLY the four governed keys are read, but an extra campaign key is NOT
 * ignored: any ungoverned `utm_*`, any legacy companion (`ref` / `referrer`), a
 * repeated governed key, or malformed percent-encoding **rejects the entire
 * tuple**, so nothing is captured at all. Stripping the stray key and accepting
 * the remainder would let a link's author keep believing a field was recorded.
 *
 * Approved platform click identifiers (`fbclid`, `gclid`, and friends) are the
 * documented exception: they may coexist with a governed tuple without
 * rejecting it, because platforms append them automatically rather than the
 * author typing them — and they are never read, stored, or forwarded.
 *
 * The path, the fragment, the referrer, and every non-campaign query parameter
 * are irrelevant here and are never stored.
 *
 * The effect runs once per mount. First-touch precedence lives in
 * `captureAttribution`, so re-running it is harmless: a live stored tuple is
 * kept, not overwritten.
 *
 * Renders nothing and never throws.
 */
export function AttributionCapture() {
  useEffect(() => {
    try {
      const search =
        typeof window !== "undefined" && typeof window.location !== "undefined"
          ? window.location.search
          : "";
      captureAttribution({
        search,
        storage: browserAttributionStorage(),
        now: Date.now(),
      });
    } catch {
      /* attribution is never allowed to break a page render */
    }
  }, []);

  return null;
}
