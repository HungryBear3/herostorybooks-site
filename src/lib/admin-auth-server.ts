import { cookies } from 'next/headers';

import { ADMIN_COOKIE, getConfiguredAdminKey } from './admin-auth.ts';

export async function isAdminAuthedFromCookie(): Promise<boolean> {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  const store = await cookies();
  const cookieVal = store.get(ADMIN_COOKIE)?.value;
  return Boolean(cookieVal) && cookieVal === configured;
}
