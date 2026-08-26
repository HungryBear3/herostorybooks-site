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
 * client navigation has replaced it. Only the four governed keys are read;
 * every other query parameter, the path, the fragment, and the referrer are
 * ignored and never stored.
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
