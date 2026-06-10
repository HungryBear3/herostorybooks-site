import { CHECKOUT_PAUSED_CODE, CHECKOUT_PAUSED_MESSAGE, isCheckoutCapacityFull, isCheckoutPaused } from './checkout-pause.ts';
import { enforceKillSwitch } from './ops-kill-switches.ts';
import { OWNER_TEST_GATE_CODE, OWNER_TEST_GATE_MESSAGE, evaluateOwnerTestGate } from './owner-test-gate.ts';
import { listOrders } from './orders.ts';

export type CheckoutAccessGateResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function evaluateCheckoutAccessGate(email: string, logPrefix = 'order'): Promise<CheckoutAccessGateResult> {
  if (isCheckoutPaused()) {
    return { ok: false, status: 503, body: { error: CHECKOUT_PAUSED_MESSAGE, code: CHECKOUT_PAUSED_CODE } };
  }

  const checkoutKs = await enforceKillSwitch('checkout_pause');
  if (checkoutKs.kind === 'active') {
    return {
      ok: false,
      status: 503,
      body: { error: CHECKOUT_PAUSED_MESSAGE, code: CHECKOUT_PAUSED_CODE, killSwitch: 'checkout_pause' },
    };
  }
  if (checkoutKs.kind === 'unavailable') {
    return {
      ok: false,
      status: 503,
      body: {
        error: CHECKOUT_PAUSED_MESSAGE,
        code: CHECKOUT_PAUSED_CODE,
        killSwitch: 'checkout_pause',
        killSwitchStateUnavailable: true,
      },
    };
  }

  if (isCheckoutCapacityFull(await listOrders())) {
    return { ok: false, status: 503, body: { error: CHECKOUT_PAUSED_MESSAGE, code: CHECKOUT_PAUSED_CODE } };
  }

  const ownerTestGate = evaluateOwnerTestGate(email);
  if (!ownerTestGate.allowed) {
    const reason = 'reason' in ownerTestGate ? ownerTestGate.reason : 'unknown';
    console.warn(`[${logPrefix}] owner-test gate refused checkout: reason=${reason}`);
    return { ok: false, status: 503, body: { error: OWNER_TEST_GATE_MESSAGE, code: OWNER_TEST_GATE_CODE } };
  }

  return { ok: true };
}
