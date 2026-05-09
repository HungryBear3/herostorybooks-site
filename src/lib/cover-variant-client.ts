'use client';

import { useEffect, useState } from 'react';

import { COVER_VARIANT_COOKIE, parseVariantCookie, type CoverVariant } from './cover-variant';

function readCookieClient(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Client hook for client components that need to read the cover variant the
 * middleware set. Defaults to 'A' on the very first render to avoid a flash;
 * the cookie value is picked up on the next paint via useEffect.
 */
export function useCoverVariant(): CoverVariant {
  const [variant, setVariant] = useState<CoverVariant>('A');
  useEffect(() => {
    const v = parseVariantCookie(readCookieClient(COVER_VARIANT_COOKIE));
    if (v && v !== variant) setVariant(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return variant;
}
