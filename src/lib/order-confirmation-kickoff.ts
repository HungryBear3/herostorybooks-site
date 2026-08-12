import { randomUUID } from 'node:crypto';
import { sendOrderConfirmationEmail as defaultSendOrderConfirmationEmail } from './order-email.ts';
import { getOrderAuthoritative, withOrderTransaction, type OrderRecord } from './orders.ts';

export interface ScheduleOrderConfirmationEmailDeps {
  send?: typeof defaultSendOrderConfirmationEmail;
  getOrder?: typeof getOrderAuthoritative;
  setImmediateImpl?: (cb: () => void) => unknown;
  afterImpl?: ((cb: () => void | Promise<void>) => void) | null;
  log?: (line: string) => void;
  errorLog?: (line: string, error?: unknown) => void;
}

const inFlight = new Map<string, Promise<void>>();

export function _resetConfirmationEmailInFlightForTest() {
  inFlight.clear();
}

export function scheduleOrderConfirmationEmail(
  order: OrderRecord,
  deps: ScheduleOrderConfirmationEmailDeps = {},
): void {
  const send = deps.send ?? defaultSendOrderConfirmationEmail;
  const setImmediateFn = deps.setImmediateImpl ?? setImmediate;
  const afterFn = deps.afterImpl;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string, error?: unknown) => console.error(line, error));

  const run = async (scheduler: string) => {
    const existing = inFlight.get(order.id);
    if (existing) {
      log(`[confirmation-email] ${scheduler} joining existing send for ${order.id}`);
      try {
        await existing;
      } catch (error) {
        // The owning scheduler logs the send failure and clears the in-flight
        // slot. A joiner must not leak an unhandled rejection from after().
        errorLog(`[confirmation-email] ${scheduler} joined failed send for ${order.id}`, error);
      }
      return;
    }

    const promise = (async () => {
      const current = deps.getOrder
        ? await deps.getOrder(order.id)
        : deps.send
          ? order
          : await getOrderAuthoritative(order.id);
      if (
        !current
        || current.paymentStatus !== 'paid'
        || current.refundedAt
        || current.stripeRefundId
        || current.refundClaimId
      ) {
        throw new Error('confirmation_email_blocked_by_authoritative_order_state');
      }
      const claimId = randomUUID();
      const claimed = deps.send ? current : await withOrderTransaction<OrderRecord | null>(
        order.id,
        (latest) => {
          if (
            latest.paymentStatus !== 'paid'
            || latest.refundedAt
            || latest.stripeRefundId
            || latest.refundClaimId
            || latest.emailResendClaimId
          ) return { abort: null };
          const updated: OrderRecord = {
            ...latest,
            emailResendClaimId: claimId,
            emailResendClaimKind: 'order_confirmation',
            emailResendClaimArtifact: latest.stripeSessionId ?? latest.id,
            emailResendClaimAt: new Date().toISOString(),
          };
          return { commit: updated, result: updated };
        },
        { notFound: () => null },
      );
      if (!claimed) throw new Error('confirmation_email_claim_blocked');

      const result = await send(claimed);
      if (result.skipped) {
        if (!deps.send) {
          await withOrderTransaction(order.id, (latest) => {
            if (latest.emailResendClaimId !== claimId) return { abort: null };
            return {
              commit: {
                ...latest,
                emailResendClaimId: null,
                emailResendClaimKind: null,
                emailResendClaimArtifact: null,
                emailResendClaimAt: null,
              },
              result: null,
            };
          }, { notFound: () => null });
        }
        throw new Error(`confirmation_email_skipped:${result.reason}`);
      }
      if (!deps.send) {
        await withOrderTransaction(order.id, (latest) => {
          if (latest.emailResendClaimId !== claimId) return { abort: null };
          return {
            commit: {
              ...latest,
              emailResendClaimId: null,
              emailResendClaimKind: null,
              emailResendClaimArtifact: null,
              emailResendClaimAt: null,
            },
            result: null,
          };
        }, { notFound: () => null });
      }
      log(`[confirmation-email] ${scheduler} completed for ${order.id}`);
    })();
    inFlight.set(order.id, promise);

    try {
      await promise;
    } catch (error) {
      inFlight.delete(order.id);
      errorLog(`[confirmation-email] ${scheduler} failed for ${order.id}`, error);
    }
  };

  setImmediateFn(() => { void run('setImmediate'); });
  if (typeof afterFn === 'function') {
    try {
      afterFn(() => run('after'));
    } catch (error) {
      errorLog(`[confirmation-email] after unavailable for ${order.id}`, error);
    }
  }
}
