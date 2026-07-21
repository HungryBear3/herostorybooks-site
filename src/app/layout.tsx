import './globals.css';
import type { Metadata } from 'next';
import Script from 'next/script';
import { SafeVercelAnalytics } from '@/components/safe-vercel-analytics';
import { AnalyticsPageView } from '@/components/analytics-page-view';

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
  openGraph: {
    title: 'Hero Story Books',
    description: 'Create a personalized keepsake storybook where your child becomes the hero.',
    url: 'https://herostorybooks.com',
    siteName: 'HeroStoryBooks',
    images: [
      {
        url: '/assets/og-social-share.png',
        width: 1200,
        height: 630,
        alt: 'HeroStoryBooks social share image',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hero Story Books',
    description: 'Personalized storybooks that turn your child into the hero of their own keepsake adventure.',
    images: ['/assets/og-social-share.png'],
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
                try {
                  if (document.referrer) {
                    var referrerUrl = new URL(document.referrer);
                    pageReferrer = referrerUrl.origin + referrerUrl.pathname;
                  }
                } catch (_) {}
                gtag('js', new Date());
                gtag('config', '${googleAnalyticsMeasurementId}', {
                  send_page_view: false,
                  page_location: pageLocation,
                  page_referrer: pageReferrer
                });
              `}
            </Script>
          </>
        ) : null}
      </head>
      <body className="bg-cream text-gray-900">
        <SafeVercelAnalytics />
        <AnalyticsPageView />
        {children}
      </body>
    </html>
  );
}
