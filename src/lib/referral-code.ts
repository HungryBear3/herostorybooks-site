export const HSB_REFERRAL_COOKIE = 'hsb_ref';
export const HSB_REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const REFERRAL_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function sanitizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  if (!REFERRAL_CODE_RE.test(code)) return null;
  return code;
}
