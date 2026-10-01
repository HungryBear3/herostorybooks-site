/**
 * Best-effort, post-response kickoff of the paid-order confirmation email.
 *
 * Both schedulers are bounded by the serverless invocation, so this path is an
 * optimization, not a guarantee: the durable guarantee is the scheduled sweep
 * in `confirmation-email-sweep.ts`. The claim, the send and the receipt all
 * live in `confirmation-email-delivery.ts` so that this path and the sweep
 * share one protocol and one provider identity.
 */
import {
  classifyConfirmationEmailError,
  deliverOrderConfirmationEmail,
  type ConfirmationEmailDeliveryOutcome,
  type DeliverOrderConfirmationEmailDeps,
} from './confirmation-email-delivery.ts';
import { sendOrderConfirmationEmail as defaultSendOrderConfirmationEmail } from './order-email.ts';
import { getOrderAuthoritative, type OrderRecord } from './orders.ts';

export interface ScheduleOrderConfirmationEmailDeps {
  send?: typeof defaultSendOrderConfirmationEmail;
  getOrder?: typeof getOrderAuthoritative;
  setImmediateImpl?: (cb: () => void) => unknown;
  afterImpl?: ((cb: () => void | Promise<void>) => void) | null;
  log?: (line: string) => void;
  /** Pre-sanitized lines only: provider and storage errors can quote the
   *  recipient address, so nothing raw crosses this boundary. */
  errorLog?: (line: string) => void;
  /** A3-4 R2: passed through to delivery only when present. */
  envelopeWriter?: DeliverOrderConfirmationEmailDeps['envelopeWriter'];
}

const inFlight = new Map<string, Promise<void>>();

export function _resetConfirmationEmailInFlightForTest() {
  inFlight.clear();
}

/** A non-`sent` outcome ends this attempt. It is carried as a bounded code —
 *  built only from this module's own literals plus the delivery layer's
 *  classification — so the scheduler can log why without ever touching a
 *  provider or storage error. */
class ConfirmationEmailAttemptError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ConfirmationEmailAttemptError';
    this.code = code;
  }
}

/**
 * What one delivery outcome means for this attempt: `null` when it completed
 * benignly, otherwise the bounded error that ends it.
 *
 * A3-4 R2: exhaustive. `snapshotted` completes the attempt (nothing was sent,
 * and nothing should be retried by a joining scheduler); a record waiting for
 * the frozen dispatcher is a benign refusal, not an error. A hold and a
 * deferral end the attempt with their own closed codes, so a later scheduler
 * or the sweep may retry a deferral.
 */
function outcomeError(outcome: ConfirmationEmailDeliveryOutcome): ConfirmationEmailAttemptError | null {
  switch (outcome.status) {
    case 'sent':
    case 'snapshotted':
      return null;
    case 'skipped':
      return new ConfirmationEmailAttemptError(`confirmation_email_skipped:${outcome.reason}`);
    case 'blocked':
      if (outcome.reason === 'awaiting_frozen_dispatch') return null;
      return new ConfirmationEmailAttemptError(`confirmation_email_blocked:${outcome.reason}`);
    case 'receipt_unrecorded':
      return new ConfirmationEmailAttemptError(`confirmation_email_receipt_unrecorded:${outcome.reason}`);
    case 'failed':
      return new ConfirmationEmailAttemptError(`confirmation_email_send_failed:${outcome.errorClass}`);
    case 'held':
      return new ConfirmationEmailAttemptError(`confirmation_email_held:${outcome.reason}`);
    case 'snapshot_deferred':
      return new ConfirmationEmailAttemptError(`confirmation_email_snapshot_deferred:${outcome.reason}`);
  }
  const _exhaustive: never = outcome;
  return _exhaustive;
}

/** The benign completion line for an outcome `outcomeError` accepted. */
function completionLine(scheduler: string, orderId: string, outcome: ConfirmationEmailDeliveryOutcome): string {
  if (outcome.status === 'snapshotted') return `[confirmation-email] ${scheduler} snapshotted for ${orderId}`;
  if (outcome.status === 'blocked') return `[confirmation-email] ${scheduler} awaiting frozen dispatch for ${orderId}`;
  return `[confirmation-email] ${scheduler} completed for ${orderId}`;
}

/** Anything else that reached the catch is unexpected; report its class only. */
function attemptErrorCode(error: unknown): string {
  return error instanceof ConfirmationEmailAttemptError
    ? error.code
    : `unexpected:${classifyConfirmationEmailError(error)}`;
}

export function scheduleOrderConfirmationEmail(
  order: OrderRecord,
  deps: ScheduleOrderConfirmationEmailDeps = {},
): void {
  const setImmediateFn = deps.setImmediateImpl ?? setImmediate;
  const afterFn = deps.afterImpl;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));

  const run = async (scheduler: string) => {
    const existing = inFlight.get(order.id);
    if (existing) {
      log(`[confirmation-email] ${scheduler} joining existing send for ${order.id}`);
      try {
        await existing;
      } catch (error) {
        // The owning scheduler logs the send failure and clears the in-flight
        // slot. A joiner must not leak an unhandled rejection from after().
        errorLog(
          `[confirmation-email] ${scheduler} joined failed send for ${order.id}`
            + ` reason=${attemptErrorCode(error)}`,
        );
      }
      return;
    }

    const promise = (async () => {
      const outcome = await deliverOrderConfirmationEmail(order.id, {
        ...(deps.send ? { send: deps.send } : {}),
        ...(deps.getOrder ? { getOrder: deps.getOrder } : {}),
        ...(deps.envelopeWriter ? { envelopeWriter: deps.envelopeWriter } : {}),
        log,
        errorLog,
      });
      const error = outcomeError(outcome);
      if (error) throw error;
      log(completionLine(scheduler, order.id, outcome));
    })();
    inFlight.set(order.id, promise);

    try {
      await promise;
    } catch (error) {
      inFlight.delete(order.id);
      errorLog(
        `[confirmation-email] ${scheduler} failed for ${order.id}`
          + ` reason=${attemptErrorCode(error)}`,
      );
    }
  };

  setImmediateFn(() => { void run('setImmediate'); });
  if (typeof afterFn === 'function') {
    try {
      afterFn(() => run('after'));
    } catch (error) {
      errorLog(
        `[confirmation-email] after unavailable for ${order.id}`
          + ` errorClass=${classifyConfirmationEmailError(error)}`,
      );
    }
  }
}
