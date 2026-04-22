import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL('https://herostorybooks.com'),
  title: 'Hero Story Books',
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
      <body className="bg-cream text-gray-900">{children}</body>
    </html>
  );
}
