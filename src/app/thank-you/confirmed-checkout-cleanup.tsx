'use client';

import { useEffect } from 'react';

import {
  CHECKOUT_DRAFT_STORAGE_KEY,
  clearCheckoutAfterConfirmedPayment,
} from '@/lib/checkout-saved-draft';

export function ConfirmedCheckoutCleanup({ attemptId }: { attemptId: string }) {
  useEffect(() => {
    try {
      clearCheckoutAfterConfirmedPayment(
        sessionStorage,
        localStorage,
        attemptId,
        CHECKOUT_DRAFT_STORAGE_KEY,
      );
    } catch {
      // Payment is already server-confirmed. Browser storage failures are
      // non-fatal and conservatively leave any surviving recovery evidence.
    }
  }, [attemptId]);

  return null;
}
