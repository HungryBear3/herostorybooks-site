import type { VerifiedGroupBookPrincipal } from './ownership.ts';

/** Exact existing HSB tenant; never accept a URL from a request or another business. */
export const CLASSROOM_AUTH_URL = 'https://uedeigimwdabjlereedy.supabase.co/auth/v1';
export const CLASSROOM_AUTH_COOKIE = 'hsb_classroom_auth';
export const CLASSROOM_OTP_LENGTH = 8;

function emailInput(email: string) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid_email');
  return email;
}

/** Server-only managed Auth REST adapter. No OTP generation/storage, JWT decode trust,
 * service role, custom identity database, or refresh-token persistence. */
export function createManagedClassroomAuth(publishableKey: string, fetcher: typeof fetch = fetch) {
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) throw new Error('auth_not_configured');
  async function call(path: '/otp' | '/verify' | '/user', body?: object, bearer?: string): Promise<Record<string, unknown>> {
    try {
      const response = await fetcher(`${CLASSROOM_AUTH_URL}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { apikey: publishableKey, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(response.status === 429 ? 'auth_rate_limited' : 'auth_unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('auth_unavailable');
      return data as Record<string, unknown>;
    } catch (error) {
      throw new Error(error instanceof Error && error.message === 'auth_rate_limited' ? 'auth_rate_limited' : 'auth_unavailable');
    }
  }
  async function principal(accessToken: string): Promise<VerifiedGroupBookPrincipal | null> {
    if (!accessToken || accessToken.length > 8192 || /\s/.test(accessToken)) return null;
    try {
      // Online validation binds issuer to this pinned endpoint, not untrusted JWT claims.
      const user = await call('/user', undefined, accessToken);
      if (typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) ||
          user.is_anonymous !== false || typeof user.email_confirmed_at !== 'string' || !Number.isFinite(Date.parse(user.email_confirmed_at))) return null;
      return {issuer: CLASSROOM_AUTH_URL, subject: user.id, emailVerified: true};
    } catch { return null; }
  }
  return {
    principal,
    async requestCode(email: string): Promise<void> {
      await call('/otp', {email: emailInput(email), create_user: true});
    },
    async verifyCode(email: string, token: string) {
      emailInput(email);
      if (!/^\d{8}$/.test(token)) throw new Error('invalid_code');
      const data = await call('/verify', {email, token, type: 'email'});
      if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' || !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) throw new Error('auth_unavailable');
      const verified = await principal(data.access_token);
      if (!verified) throw new Error('auth_unavailable');
      return {accessToken: data.access_token, expiresIn: data.expires_in, principal: verified};
    },
  };
}
