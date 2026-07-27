import type { MetadataRoute } from 'next';
import { GIFT_OCCASIONS } from '@/lib/gift-occasions';
import { PRODUCTION_ORIGIN } from '@/lib/site-url';

export default function sitemap(): MetadataRoute.Sitemap {
  // Sitemap <loc> values must always be production-host so preview deployments
  // never emit preview URLs into a crawlable sitemap. Use the shared production
  // origin, NOT the preview-aware getSiteOrigin helper.
  const origin = PRODUCTION_ORIGIN;

  return [
    {
      url: origin,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${origin}/samples`,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${origin}/about`,
      changeFrequency: 'yearly',
      priority: 0.6,
    },
    {
      url: `${origin}/gifts`,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    ...GIFT_OCCASIONS.map(({ id }) => ({
      url: `${origin}/gifts/${id}`,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
    {
      url: `${origin}/privacy`,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
    {
      url: `${origin}/terms`,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
  ];
}
