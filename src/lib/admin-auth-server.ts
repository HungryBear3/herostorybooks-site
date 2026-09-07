import { cookies } from 'next/headers';

import { ADMIN_COOKIE, getConfiguredAdminKey } from './admin-auth.ts';
import { timingSafeEqualStr } from './cron-auth.ts';

export async function isAdminAuthedFromCookie(): Promise<boolean> {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  const store = await cookies();
  const cookieVal = store.get(ADMIN_COOKIE)?.value;
  if (!cookieVal) return false;
  return timingSafeEqualStr(cookieVal, configured);
}
