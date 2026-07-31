export const CONFIRMATION_POLL_INTERVAL_MS = 1_500;
export const STRIPE_FALLBACK_DELAY_MS = 5_000;
export const CONFIRMATION_TIMEOUT_MS = 60_000;

export interface ConfirmationPollDecision {
  shouldPoll: boolean;
  includeStripeSession: boolean;
  showSupportState: boolean;
}

export function getConfirmationPollDecision(elapsedMs: number): ConfirmationPollDecision {
  if (elapsedMs >= CONFIRMATION_TIMEOUT_MS) {
    return {
      shouldPoll: false,
      includeStripeSession: false,
      showSupportState: true,
    };
  }

  return {
    shouldPoll: true,
    includeStripeSession: elapsedMs >= STRIPE_FALLBACK_DELAY_MS,
    showSupportState: false,
  };
}
