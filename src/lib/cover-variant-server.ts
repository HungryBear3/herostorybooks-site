import { cookies } from 'next/headers';

import {
  COVER_VARIANT_COOKIE,
  parseVariantCookie,
  pickVariant,
  type CoverVariant,
} from './cover-variant';

/**
 * Read the cover-variant cookie from a server component. Falls back to a
 * non-sticky `pickVariant()` if the cookie is missing — but this should be rare
 * because the middleware sets it on first hit.
 */
export async function getServerCoverVariant(): Promise<CoverVariant> {
  const store = await cookies();
  const v = parseVariantCookie(store.get(COVER_VARIANT_COOKIE)?.value);
  return v ?? pickVariant();
}
