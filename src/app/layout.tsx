import './globals.css';
import type { Metadata } from 'next';
import { AnalyticsPageView } from '@/components/analytics-page-view';
import { BrowserAnalytics } from '@/components/marketing/browser-analytics';
import { MetaPixelMount } from '@/components/marketing/meta-pixel-mount';
import { ConsentSurface } from '@/components/marketing/consent-surface';
import { AttributionCapture } from '@/components/marketing/attribution-capture';
import { resolveAnalyticsMode } from '@/lib/marketing/preview-validation';

const googleAnalyticsMeasurementId = 'G-68FKEDZEG3';
const googleAnalyticsEnabled = process.env.VERCEL_ENV === 'production';

/**
 * Which GA4 property, if any, this deployment may measure into. Resolved on the
 * server so the environment reads stay here; consent is applied separately, in
 * the client component, exactly as it is in Production.
 */
const analyticsMode = resolveAnalyticsMode({
  vercelEnv: process.env.VERCEL_ENV,
  productionMeasurementId: googleAnalyticsMeasurementId,
  previewFlag: process.env.NEXT_PUBLIC_HSB_ANALYTICS_PREVIEW_VALIDATION,
  previewMeasurementId: process.env.NEXT_PUBLIC_HSB_PREVIEW_GA_MEASUREMENT_ID,
});

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
      <body className="bg-cream text-gray-900">
        {/* Optional analytics: rendered only on a granted consent. Nothing
            is loaded, mounted, or requested while consent is unknown,
            declined, or withdrawn. */}
        <BrowserAnalytics
          measurementId={analyticsMode.measurementId}
          mode={analyticsMode.mode}
        />
        <AttributionCapture />
        <AnalyticsPageView />
        <MetaPixelMount />
        {children}
        <ConsentSurface />
      </body>
    </html>
  );
}
