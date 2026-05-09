'use client';

import Image, { type ImageProps } from 'next/image';
import { useEffect, useState } from 'react';

import {
  coverUrlForVariant,
  type CoverVariant,
} from '@/lib/cover-variant';
import { trackVariantShown } from '@/lib/analytics';

type Props = Omit<ImageProps, 'src'> & {
  /** The illustrative (variant A) source path. Variant B is derived. */
  src: string;
  /** Server-supplied variant. Falls back to A if absent (no flash). */
  variant?: CoverVariant;
  /** Page label for analytics, e.g. "samples", "checkout", "hero". */
  page?: string;
  /** Optional fallback when a realistic asset is missing on disk. */
  fallbackSrc?: string;
};

/**
 * Conditional cover image for the A/B test.
 * - Renders the illustrative image when variant === 'A' (default).
 * - Renders the realistic counterpart from /assets/covers/realistic/<basename>
 *   when variant === 'B', falling back to the illustrative image if the
 *   realistic asset 404s on the client.
 * - Fires `cover_variant_shown` exactly once per mount.
 */
export function CoverPreview({
  src,
  variant = 'A',
  page,
  fallbackSrc,
  alt,
  ...rest
}: Props) {
  const initial = coverUrlForVariant(src, variant);
  const [resolvedSrc, setResolvedSrc] = useState<string>(initial);

  useEffect(() => {
    if (page) trackVariantShown(variant, page);
    // Re-sync if props change (e.g., theme switch in checkout).
    setResolvedSrc(coverUrlForVariant(src, variant));
  }, [src, variant, page]);

  return (
    <Image
      {...rest}
      src={resolvedSrc}
      alt={alt}
      onError={() => {
        // If the realistic asset is missing, fall back gracefully without
        // breaking the page. Variant B becomes variant A visually.
        const fallback = fallbackSrc ?? src;
        if (resolvedSrc !== fallback) setResolvedSrc(fallback);
      }}
    />
  );
}
