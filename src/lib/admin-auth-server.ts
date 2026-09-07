import { headers } from 'next/headers';

import { getConfiguredAdminKey, readAdminSessionCookie } from './admin-auth.ts';
import { timingSafeEqualStr } from './cron-auth.ts';

export async function isAdminAuthedFromCookie(): Promise<boolean> {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  // The raw `Cookie` header, not `cookies()`: RequestCookies collapses duplicate
  // `hsb-ops-key` entries into one (last wins), so this reader could not see —
  // let alone reject — the ambiguity `isAdminAuthedFromRequest` sees. Reading the
  // header keeps both readers on one parser and one verdict. See
  // readAdminSessionCookie.
  const cookie = readAdminSessionCookie((await headers()).get('cookie'));
  if (cookie === null) return false;
  return timingSafeEqualStr(cookie, configured);
}
