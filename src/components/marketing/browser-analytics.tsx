"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { SafeVercelAnalytics } from "@/components/safe-vercel-analytics";
import { getConsent, subscribeConsent } from "@/lib/marketing/consent-store";
import type { ConsentState } from "@/lib/marketing/consent";

/**
 * Every optional browser analytics destination, mounted ONLY on a grant.
 *
 * WHY THIS EXISTS RATHER THAN CONSENT MODE. An earlier revision loaded gtag
 * unconditionally and set Google Consent Mode to denied. That is not the same
 * thing: a denied Consent Mode still loads Google's script and still sends
 * cookieless pings, so a visitor who has not chosen — or who declined — has
 * already had a third-party request made on their behalf. The requirement is
 * that NO optional network behaviour happens before a grant, so the scripts
 * themselves are not rendered.
 *
 * Because the decision is made in the browser, these cannot be
 * `beforeInteractive` (that strategy injects into the server-rendered
 * document, before any consent is known). They are `afterInteractive`, which
 * is the correct strategy for something that must not exist until a client
 * event occurs. The inline stub still runs before the remote library, so
 * queued `gtag()` calls survive the gap exactly as they did before.
 *
 * ON WITHDRAWAL. React unmounts both children. Vercel's `<Analytics />` stops
 * emitting, and no further `gtag('event', ...)` is issued because
 * `src/lib/analytics.ts` is gated on the same store. Google's library may
 * remain resident in the page from the granted period — a script cannot be
 * un-run — which is why withdrawal also clears the consent record and why
 * `analytics.ts` refuses to call it. A full reload restores a page with no
 * Google script present at all.
 *
 * The production-only guard (`VERCEL_ENV === 'production'`) is unchanged and is
 * evaluated before consent even matters.
 */
export function BrowserAnalytics({
  measurementId,
  productionEnabled,
}: {
  measurementId: string;
  productionEnabled: boolean;
}) {
  const [consent, setConsentState] = useState<ConsentState>("unknown");

  useEffect(() => {
    setConsentState(getConsent());
    return subscribeConsent(setConsentState);
  }, []);

  if (!productionEnabled) return null;
  if (consent !== "granted") return null;

  return (
    <>
      <Script
        async
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics-gtag" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = window.gtag || gtag;
          var pageLocation = window.location.origin + window.location.pathname;
          var pageReferrer = '';
          var ignoreReferrer = false;
          try {
            if (document.referrer) {
              var referrerUrl = new URL(document.referrer);
              ignoreReferrer = referrerUrl.hostname.toLowerCase() === 'checkout.stripe.com';
              if (!ignoreReferrer) pageReferrer = referrerUrl.origin + referrerUrl.pathname;
            }
          } catch (_) {}
          gtag('js', new Date());
          gtag('config', '${measurementId}', {
            send_page_view: false,
            page_location: pageLocation,
            page_referrer: pageReferrer,
            ignore_referrer: ignoreReferrer
          });
        `}
      </Script>
      <SafeVercelAnalytics />
    </>
  );
}
