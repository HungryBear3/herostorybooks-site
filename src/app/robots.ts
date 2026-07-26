import type { MetadataRoute } from 'next';
import { getSiteOrigin, shouldIndexSite } from '@/lib/site-url';

const PRIVATE_ROUTES = [
  '/admin/',
  '/api/',
  '/checkout',
  '/design-previews/',
  '/family-review',
  '/order',
  '/partner/',
  '/review/',
  '/status/',
  '/thank-you',
];

export default function robots(): MetadataRoute.Robots {
  const origin = getSiteOrigin();
  const indexSite = shouldIndexSite();

  return {
    rules: {
      userAgent: '*',
      allow: indexSite ? '/' : undefined,
      disallow: indexSite ? PRIVATE_ROUTES : '/',
    },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
