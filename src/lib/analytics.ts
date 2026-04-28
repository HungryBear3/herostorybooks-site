// Thin analytics shim. Calls window.gtag if it's loaded; otherwise no-ops.
// Also forwards to Vercel Analytics if available, so the A/B test isn't dark
// when GA isn't wired yet.
import type { CoverVariant } from './cover-variant';

type GtagFn = (command: string, eventName: string, params?: Record<string, unknown>) => void;

declare global {
  interface Window {
    gtag?: GtagFn;
    // Vercel Analytics drops this at runtime when @vercel/analytics is installed.
    va?: (action: 'track', name: string, props?: Record<string, unknown>) => void;
  }
}

export type CoverEventName =
  | 'cover_variant_shown'
  | 'preview_click'
  | 'premium_select'
  | 'checkout_start';

export function trackCoverEvent(name: CoverEventName, params: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params);
    }
    if (typeof window.va === 'function') {
      window.va('track', name, params);
    }
  } catch {
    /* never let analytics throw into the UI */
  }
}

export function trackVariantShown(variant: CoverVariant, page: string) {
  trackCoverEvent('cover_variant_shown', { variant, page });
}

export function trackPreviewClick(variant: CoverVariant, extra: Record<string, unknown> = {}) {
  trackCoverEvent('preview_click', { variant, ...extra });
}

export function trackPremiumSelect(variant: CoverVariant) {
  trackCoverEvent('premium_select', { variant });
}

export function trackCheckoutStart(variant: CoverVariant) {
  trackCoverEvent('checkout_start', { variant });
}
