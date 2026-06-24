'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  HSB_REFERRAL_COOKIE,
  HSB_REFERRAL_COOKIE_MAX_AGE,
  sanitizeReferralCode,
} from '@/lib/referral-code';

export function ReferralCapture() {
  const params = useSearchParams();

  useEffect(() => {
    const code = sanitizeReferralCode(params.get('ref'));
    if (!code) return;

    document.cookie = [
      `${HSB_REFERRAL_COOKIE}=${encodeURIComponent(code)}`,
      `max-age=${HSB_REFERRAL_COOKIE_MAX_AGE}`,
      'path=/',
      'SameSite=Lax',
    ].join('; ');

    fetch('/api/referrals/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(() => {
      // Referral capture must never interrupt the buyer flow.
    });
  }, [params]);

  return null;
}
