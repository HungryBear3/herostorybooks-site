import './globals.css';
import type { Metadata } from 'next';
import Script from 'next/script';
import { SafeVercelAnalytics } from '@/components/safe-vercel-analytics';
import { AnalyticsPageView } from '@/components/analytics-page-view';
import { MetaPixelMount } from '@/components/marketing/meta-pixel-mount';
import { ConsentSurface } from '@/components/marketing/consent-surface';
import { AttributionCapture } from '@/components/marketing/attribution-capture';

const googleAnalyticsMeasurementId = 'G-68FKEDZEG3';
const googleAnalyticsEnabled = process.env.VERCEL_ENV === 'production';

export const metadata: Metadata = {
  metadataBase: new URL('https://herostorybooks.com'),
  title: 'Hero Story Books',
  other: {
    'facebook-domain-verification': 'dzkmx7nu5p61nc7end6o4xj4cl5qvo',
  },
  description: 'Personalized hero story books that help children feel brave, seen, and celebrated.',
  icons: {
    icon: '/assets/logo-icon-only.png',
    apple: '/assets/logo-icon-only.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="font-sans">
      <head>
        {googleAnalyticsEnabled ? (
          <>
            <Script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${googleAnalyticsMeasurementId}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics-gtag" strategy="beforeInteractive">
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
                // Google Consent Mode v2, DENIED BY DEFAULT. This runs before
                // config, so no storage-backed measurement happens until the
                // visitor makes an explicit choice. The consent surface calls
                // gtag('consent','update',...) on a grant; declining leaves
                // these defaults in place. Essential site behaviour and the
                // trusted server-side Stripe purchase path do not consult this.
                gtag('consent', 'default', {
                  ad_storage: 'denied',
                  ad_user_data: 'denied',
                  ad_personalization: 'denied',
                  analytics_storage: 'denied',
                  functionality_storage: 'granted',
                  security_storage: 'granted'
                });
                gtag('js', new Date());
                gtag('config', '${googleAnalyticsMeasurementId}', {
                  send_page_view: false,
                  page_location: pageLocation,
                  page_referrer: pageReferrer,
                  ignore_referrer: ignoreReferrer
                });
              `}
            </Script>
          </>
        ) : null}
      </head>
      <body className="bg-cream text-gray-900">
        <SafeVercelAnalytics />
        <AttributionCapture />
        <AnalyticsPageView />
        <MetaPixelMount />
        {children}
        <ConsentSurface />
      </body>
    </html>
  );
}
