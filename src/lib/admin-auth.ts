export const ADMIN_COOKIE = 'hsb-ops-key';

export function getConfiguredAdminKey(): string | undefined {
  return process.env.HSB_ORDER_ADMIN_KEY;
}

export function isAdminAuthedFromRequest(request: Request): boolean {
  const configured = getConfiguredAdminKey();
  if (!configured) return false;
  const header = request.headers.get('x-hsb-order-admin-key');
  if (header && header === configured) return true;
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));
  return Boolean(match) && match![1] === configured;
}
