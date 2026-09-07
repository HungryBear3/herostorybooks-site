import { timingSafeEqualStr } from './cron-auth.ts';

export const ADMIN_COOKIE = 'hsb-ops-key';

export function getConfiguredAdminKey(): string | undefined {
  // Trim the classic dashboard paste artifact; a whitespace-only value still
  // fails closed. Mirrors family-review/admin-auth.ts:37.
  return process.env.HSB_ORDER_ADMIN_KEY?.trim() || undefined;
}

export function isAdminAuthedFromRequest(request: Request): boolean {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  const header = request.headers.get('x-hsb-order-admin-key');
  if (header && timingSafeEqualStr(header, configured)) return true;
  const cookie = request.headers.get('cookie') ?? '';
  // Anchor on a cookie-name boundary so a look-alike name can neither shadow
  // the real cookie nor stand in for it. Cf. family-review/admin-auth.ts:70.
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]*)`));
  if (!match) return false;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    value = match[1];
  }
  return timingSafeEqualStr(value, configured);
}
