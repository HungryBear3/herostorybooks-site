"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachCrossTabConsentSync,
  getConsent,
  setConsent,
  clearConsent,
  subscribeConsent,
} from "@/lib/marketing/consent-store";
import type { ConsentState } from "@/lib/marketing/consent";

/**
 * The one consent surface. It governs GA4 and Meta together.
 *
 * BEHAVIOUR
 *   - No stored choice -> the banner is shown and nothing optional is running.
 *   - "Accept" and "Decline" are the same two buttons: same size, same weight,
 *     same one click. No pre-selection, no "continue browsing means yes", no
 *     styling that makes decline the quiet option.
 *   - A choice takes effect immediately in this tab through the shared store,
 *     with no reload: GA4 gets a Consent Mode update and the Meta adapter is
 *     re-offered the current route exactly once.
 *   - "Cookie choices" stays available afterwards so the decision can be
 *     changed. Changing it withdraws the stored choice and re-offers the
 *     banner rather than silently flipping to a grant.
 *
 * Essential site behaviour, ordering, payment, and the trusted server-side
 * Stripe purchase path never consult this component.
 */

function updateGoogleConsent(state: ConsentState): void {
  if (typeof window === "undefined") return;
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof gtag !== "function") return;
  const value = state === "granted" ? "granted" : "denied";
  try {
    gtag("consent", "update", {
      ad_storage: value,
      ad_user_data: value,
      ad_personalization: value,
      analytics_storage: value,
    });
  } catch {
    /* analytics must never throw into the UI */
  }
}

export function ConsentSurface() {
  const [state, setState] = useState<ConsentState>("unknown");
  const [ready, setReady] = useState(false);
  const [reopened, setReopened] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Read once on mount. Until this runs the state is 'unknown', which is the
    // fail-closed default, so nothing optional can have started.
    const initial = getConsent();
    setState(initial);
    setReady(true);
    updateGoogleConsent(initial);

    const unsubscribe = subscribeConsent((next) => {
      setState(next);
      updateGoogleConsent(next);
    });
    const detach = attachCrossTabConsentSync();
    return () => {
      unsubscribe();
      detach();
    };
  }, []);

  // A fixed banner at the bottom of the viewport OVERLAPS whatever is there.
  // That is not only cosmetic: it made the customer text editor's resize handle
  // unreachable, which the Chromium suite caught. Reserve the banner's own
  // height at the foot of the document while it is visible, and give it back on
  // dismissal, so nothing interactive is ever underneath it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const body = document.body;
    if (!body) return;
    const node = bannerRef.current;
    if (!node) {
      body.style.paddingBottom = "";
      return;
    }
    const previous = body.style.paddingBottom;
    body.style.paddingBottom = `${node.offsetHeight}px`;
    return () => {
      body.style.paddingBottom = previous;
    };
  });

  const accept = useCallback(() => {
    setConsent("granted");
    setReopened(false);
  }, []);

  const decline = useCallback(() => {
    setConsent("denied");
    setReopened(false);
  }, []);

  const reopen = useCallback(() => {
    // Withdraw first: changing your mind must never leave a grant standing
    // while the banner is being re-read.
    clearConsent();
    setReopened(true);
  }, []);

  if (!ready) return null;

  const showBanner = state === "unknown" || reopened;

  if (!showBanner) {
    return (
      <button
        type="button"
        onClick={reopen}
        data-testid="consent-reopen"
        style={{
          position: "fixed",
          bottom: "0.75rem",
          left: "0.75rem",
          zIndex: 60,
          background: "transparent",
          border: "none",
          padding: "0.25rem 0.5rem",
          font: "inherit",
          fontSize: "0.75rem",
          color: "#4b5563",
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        Cookie choices
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="hsb-consent-title"
      aria-describedby="hsb-consent-body"
      data-testid="consent-banner"
      ref={bannerRef}
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        zIndex: 60,
        background: "#fffdf7",
        borderTop: "1px solid #d8cfbc",
        padding: "1rem",
        boxShadow: "0 -2px 12px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ maxWidth: "48rem", margin: "0 auto" }}>
        <h2
          id="hsb-consent-title"
          style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}
        >
          Optional analytics
        </h2>
        <p
          id="hsb-consent-body"
          style={{ margin: "0.5rem 0 0.75rem", fontSize: "0.875rem", lineHeight: 1.5 }}
        >
          We&rsquo;d like to measure which pages help families find us. This is
          optional and off until you choose. Declining changes nothing about
          your order, your photos, or your book &mdash; everything on the site
          keeps working either way.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={accept}
            data-testid="consent-accept"
            style={buttonStyle}
          >
            Accept
          </button>
          <button
            type="button"
            onClick={decline}
            data-testid="consent-decline"
            style={buttonStyle}
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One style object for both buttons. Identical by construction, so a future
 * edit cannot make decline quieter than accept without changing both.
 */
const buttonStyle: React.CSSProperties = {
  font: "inherit",
  fontSize: "0.875rem",
  fontWeight: 600,
  padding: "0.5rem 1.25rem",
  borderRadius: "0.375rem",
  border: "1px solid #14532d",
  background: "#ffffff",
  color: "#14532d",
  cursor: "pointer",
  minWidth: "7rem",
};
