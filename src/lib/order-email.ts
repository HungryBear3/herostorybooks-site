import { Resend } from 'resend';

import type { OrderRecord } from './orders';
import { renderDeliveryExpectation } from './orders.ts';
import {
  PROOF_DELAY_SUPPORT_NOTE,
  PROOF_REVIEW_ASSURANCE,
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from './proof-turnaround.ts';

const DEFAULT_SUPPORT_EMAIL = 'support@herostorybooks.com';
const DEFAULT_FROM_EMAIL = 'Hero Story Books <onboarding@resend.dev>';

function isPrintFormat(order: OrderRecord) {
  return order.bookFormat === 'classic' || order.bookFormat === 'premium';
}

export function getSupportEmail() {
  return process.env.HSB_SUPPORT_EMAIL || process.env.EMAIL_FROM || DEFAULT_SUPPORT_EMAIL;
}

export function getOrderSenderEmail() {
  return process.env.HSB_EMAIL_FROM || process.env.EMAIL_FROM || DEFAULT_FROM_EMAIL;
}

/**
 * Verified-sender fallback used when the primary configured sender fails
 * Resend's domain-verification check (HTTP 403 "domain is not verified").
 *
 * Operator UX:
 *   1. Set `HSB_EMAIL_FROM` to the branded sender (e.g.
 *      "Hero Story Books <support@herostorybooks.com>").
 *   2. Set `HSB_EMAIL_FROM_FALLBACK` to a sender on a Resend-verified
 *      domain (e.g. "Hero Story Books <onboarding@resend.dev>") so
 *      production fulfillment can still deliver while we work on
 *      verifying the production domain.
 *
 * When the fallback is unset, a domain-not-verified failure surfaces a
 * clear, actionable error instead of a generic Resend message.
 */
export function getFallbackSenderEmail(): string | null {
  return process.env.HSB_EMAIL_FROM_FALLBACK ?? null;
}

interface ResendError {
  statusCode?: number;
  name?: string;
  message?: string;
}

function isDomainNotVerifiedError(error: ResendError | null | undefined): boolean {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
  if (error.statusCode === 403 && /domain.*verified|verify.*domain/.test(message)) {
    return true;
  }
  // Resend has been seen returning the same hint under `name` in some clients.
  if ((error.name || '').toLowerCase().includes('domain') && /verif/i.test(error.message || '')) {
    return true;
  }
  return false;
}

function formatActionableError(
  context: string,
  sender: string,
  error: ResendError,
): string {
  const statusFragment = error.statusCode ? ` (${error.statusCode})` : '';
  const message = error.message || error.name || 'Unknown Resend error';
  if (isDomainNotVerifiedError(error)) {
    const fallbackHint = getFallbackSenderEmail()
      ? ' (fallback HSB_EMAIL_FROM_FALLBACK also failed; verify that sender too)'
      : ' — verify the sending domain at https://resend.com/domains, or set HSB_EMAIL_FROM_FALLBACK to a sender on an already-verified domain (e.g. "Hero Story Books <onboarding@resend.dev>")';
    return `${context} failed${statusFragment}: sender ${sender} is not on a verified Resend domain${fallbackHint}. Underlying error: ${message}`;
  }
  return `${context} failed${statusFragment}: ${message}`;
}

function assertResendSuccess(
  result: {
    data?: { id?: string | null } | null;
    error?: ResendError | null;
  },
  context: string,
  sender: string = getOrderSenderEmail(),
) {
  if (result.error) {
    const actionable = formatActionableError(context, sender, result.error);
    console.error(`[order-email] ${actionable}`);
    throw new Error(actionable);
  }

  if (!result.data?.id) {
    throw new Error(`${context} returned no provider message id; outcome requires reconciliation`);
  }
  return { skipped: false as const, id: result.data.id };
}

/**
 * Send via Resend with an optional verified-sender fallback. If the
 * primary `from` returns a 403 "domain is not verified" and a fallback
 * sender is configured, the send is retried once with the fallback.
 * Either the success result is returned, or the final error is thrown
 * via `assertResendSuccess` with an actionable message.
 */
async function sendWithFallback(
  resend: Resend,
  context: string,
  payload: {
    from: string;
    to: string[];
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
  },
  options: {
    primaryIdempotencyKey?: string;
    fallbackIdempotencyKey?: string;
  } = {},
) {
  const primary = await resend.emails.send(
    payload,
    options.primaryIdempotencyKey
      ? { idempotencyKey: options.primaryIdempotencyKey }
      : undefined,
  );
  if (!primary.error) {
    return assertResendSuccess(primary, context, payload.from);
  }

  const fallback = getFallbackSenderEmail();
  if (fallback && fallback !== payload.from && isDomainNotVerifiedError(primary.error)) {
    console.warn(
      `[order-email] ${context}: primary sender ${payload.from} unverified — retrying with HSB_EMAIL_FROM_FALLBACK=${fallback}`,
    );
    const retry = await resend.emails.send(
      { ...payload, from: fallback },
      options.fallbackIdempotencyKey
        ? { idempotencyKey: options.fallbackIdempotencyKey }
        : undefined,
    );
    return assertResendSuccess(retry, context, fallback);
  }

  // No fallback available, or the failure was not a domain issue. Surface
  // the actionable error message and throw.
  return assertResendSuccess(primary, context, payload.from);
}

export function buildOrderConfirmationEmail(
  order: OrderRecord,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const previewNote = order.bookFormat === 'digital'
    ? `Your digital proof is usually ready in ${PROOF_TURNAROUND_WINDOW}, and the full high-resolution PDF comes with it — read it right away, ask for changes if anything is off, and approve when it is right.`
    : 'Your digital preview will arrive first so you can approve it before it prints.';

  const subject = `${order.childName}'s Hero Story Books order is in`;
  const detailRows = [
    ['Child name', order.childName],
    ['Format', order.formatLabel],
    ['Delivery', renderDeliveryExpectation(order.deliveryExpectation)],
    ['Order ID', order.id],
  ].filter(([, value]) => Boolean(value));

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">We received ${escapeHtml(order.childName)}'s storybook order ✨</h1>
      <p style="margin:0 0 16px;">Thanks for ordering with Hero Story Books. We're getting ${escapeHtml(order.childName)}'s adventure started now.</p>
      <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:16px;padding:20px;margin-bottom:20px;">
        ${detailRows.map(([label, value]) => `<p style="margin:0 0 8px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join('')}
      </div>
      <p style="margin:0 0 12px;">${escapeHtml(previewNote)}</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;"><strong>Before production:</strong> please send any final reference-photo changes together as soon as possible. Once production begins, new photos, characters, scenes, major story changes, or a new creative direction require a $19 restart fee and reset the timeline.</p>
      <p style="margin:0 0 12px;">${escapeHtml(PROOF_REVIEW_ASSURANCE)} ${escapeHtml(PROOF_VOLUME_NOTE)}</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:14px;">${escapeHtml(PROOF_DELAY_SUPPORT_NOTE)}</p>
      <p style="margin:0 0 12px;">If you have questions, just reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Proof approval before print · Personalized with care by Hero Story Books</p>
    </div>
  `;

  const text = [
    `We received ${order.childName}'s storybook order ✨`,
    '',
    `Child name: ${order.childName}`,
    `Format: ${order.formatLabel}`,
    `Delivery: ${renderDeliveryExpectation(order.deliveryExpectation)}`,
    `Order ID: ${order.id}`,
    '',
    previewNote,
    `Before production: please send any final reference-photo changes together as soon as possible. Once production begins, new photos, characters, scenes, major story changes, or a new creative direction require a $19 restart fee and reset the timeline.`,
    `${PROOF_REVIEW_ASSURANCE} ${PROOF_VOLUME_NOTE}`,
    PROOF_DELAY_SUPPORT_NOTE,
    `Track your order: ${(process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'https://herostorybooks.com')}/status/${order.id}`,
    `Questions? ${supportEmail}`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * Provider-level deduplication identity for the paid-order confirmation.
 *
 * Derived from the order id alone — never from the attempt, the claim, the
 * sender configuration, or any customer field — so every retry (deferred
 * scheduler, webhook replay, recovery sweep) presents Resend with the same key
 * and can only ever produce one accepted message. That is what makes the
 * ambiguous case safe: if Resend accepted the email but our durable receipt
 * write was lost, re-sending is a no-op at the provider rather than a second
 * confirmation in the buyer's inbox.
 *
 * ONE key, because there is one sender. Resend rejects reuse of a key whose
 * request body has changed, so a `-primary`/`-fallback` pair sharing this value
 * would make the fallback permanently unusable, and a pair splitting it by
 * sender would let an `HSB_EMAIL_FROM` change open a second identity. The
 * sender is therefore frozen alongside this key on the order record
 * (`confirmationEmailFrom`) and the confirmation path never falls back. The
 * retained `-primary-v1` suffix is legacy compatibility, not an active half of
 * a fallback pair. Other lifecycle emails keep their separate
 * `-primary`/`-fallback` keys.
 */
export function buildOrderConfirmationIdempotencyKey(order: OrderRecord): string {
  // Preserve the pre-cutover primary identity so a confirmation accepted by
  // the old primary path but missing its durable receipt still deduplicates.
  return `order-confirmation-${order.id}-primary-v1`;
}

/** The record carries no frozen identity, so there is nothing safe to present.
 *  Fail closed rather than reconstruct one from the current environment: a
 *  reconstructed identity is exactly the duplicate this design prevents. */
export class ConfirmationEmailIdentityError extends Error {
  constructor(orderId: string) {
    super(`Order confirmation email for ${orderId} has no persisted sender identity`);
    this.name = 'ConfirmationEmailIdentityError';
  }
}

/**
 * Bounded, PII-free confirmation-send failure.
 *
 * Resend quotes the recipient address in its error messages, and the sender
 * address is itself an address, so only the HTTP status and a name-shaped
 * classification cross this boundary — never a message, and never an `@`. The
 * rejected sender is recoverable from `confirmationEmailFrom` on the record.
 */
export class ConfirmationEmailProviderError extends Error {
  readonly statusCode: number | null;

  readonly providerErrorClass: string;

  constructor(orderId: string, detail: ResendError | null | undefined) {
    const statusCode = typeof detail?.statusCode === 'number' ? detail.statusCode : null;
    const rawName = typeof detail?.name === 'string' ? detail.name : '';
    const providerErrorClass = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawName) ? rawName : 'unknown';
    super(
      `Order confirmation email for ${orderId} was rejected by the provider`
        + ` (status=${statusCode ?? 'unknown'} providerErrorClass=${providerErrorClass});`
        + ' the rejected sender is recorded as confirmationEmailFrom on the order',
    );
    this.name = 'ConfirmationEmailProviderError';
    this.statusCode = statusCode;
    this.providerErrorClass = providerErrorClass;
  }
}

/**
 * Send the paid-order confirmation under the identity already frozen on the
 * record: exactly one provider attempt, with that exact `from` and that exact
 * idempotency key.
 *
 * Deliberately does NOT use `sendWithFallback`. A verified-sender fallback
 * changes `from`, which changes the request body, which Resend refuses under an
 * already-seen key — so the fallback could never succeed, and giving it its own
 * key would instead let a sender rotation deliver the confirmation twice. If
 * the frozen sender is rejected, this throws and the attempt is retried later
 * under the same identity; correcting the sender is an operator migration, not
 * something this path may decide.
 */
export async function sendOrderConfirmationEmail(order: OrderRecord) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { skipped: true as const, reason: 'missing_resend_api_key' };
  }

  const from = order.confirmationEmailFrom;
  const idempotencyKey = order.confirmationEmailIdempotencyKey;
  if (!from || !idempotencyKey) throw new ConfirmationEmailIdentityError(order.id);

  const resend = new Resend(apiKey);
  const supportEmail = getSupportEmail();
  const email = buildOrderConfirmationEmail(order, { supportEmail });
  const result = await resend.emails.send({
    from,
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  }, { idempotencyKey });

  if (result.error) throw new ConfirmationEmailProviderError(order.id, result.error);
  if (!result.data?.id) {
    throw new ConfirmationEmailProviderError(order.id, { name: 'missing_provider_message_id' });
  }
  return { skipped: false as const, id: result.data.id };
}

// ── Frozen confirmation dispatch (L-4 A3-5) ──────────────────────────────────

/** The six stored request fields, exactly as the frozen envelope holds them. */
export interface FrozenConfirmationRequest {
  readonly from: string;
  readonly to: readonly [string];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo: string;
}

/**
 * What one frozen dispatch did, as closed codes. `not_submitted` is the only
 * arm that proves the request never reached the SDK; everything after the
 * submission point is reported as the provider status and a name-shaped class.
 */
export type FrozenDispatchTransportResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'not_submitted'; cause: 'missing_resend_api_key' | 'client_construction' | 'argument_invalid' }
  | { kind: 'provider_error'; statusCode: number | null; providerErrorClass: string }
  | { kind: 'no_message_id' }
  | { kind: 'submit_threw'; errorClass: string };

/** A provider message id that may be written to the public record and logs. */
const FROZEN_DISPATCH_MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

function frozenDispatchClassName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : 'unknown';
}

function isFrozenConfirmationRequest(value: unknown): value is FrozenConfirmationRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return typeof request.from === 'string'
    && Array.isArray(request.to)
    && request.to.length === 1
    && typeof request.to[0] === 'string'
    && typeof request.subject === 'string'
    && typeof request.html === 'string'
    && typeof request.text === 'string'
    && typeof request.replyTo === 'string';
}

/**
 * Present one stored request to the provider, verbatim, under the stored key:
 * one SDK call at most, no sender resolution, no rendering, no record read and
 * no fallback. Never throws, and no provider message crosses the boundary.
 *
 * Resend's SDK turns every fetch failure into an error return, so nothing the
 * SDK reports can prove the request never left. Only a failure in this
 * function before `emails.send` is called is `not_submitted`.
 */
export async function dispatchFrozenConfirmationRequest(
  request: FrozenConfirmationRequest,
  idempotencyKey: string,
  deps: { createClient?: (apiKey: string) => Pick<Resend, 'emails'> } = {},
): Promise<FrozenDispatchTransportResult> {
  let valid = false;
  try {
    valid = isFrozenConfirmationRequest(request) && typeof idempotencyKey === 'string' && idempotencyKey.length > 0;
  } catch {
    // A throwing getter on the input: nothing was submitted.
  }
  if (!valid) return { kind: 'not_submitted', cause: 'argument_invalid' };
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { kind: 'not_submitted', cause: 'missing_resend_api_key' };

  let client: Pick<Resend, 'emails'>;
  try {
    client = (deps.createClient ?? ((key: string) => new Resend(key)))(apiKey);
  } catch {
    return { kind: 'not_submitted', cause: 'client_construction' };
  }

  // Set immediately before the SDK call: a throw before it is ours and proven
  // pre-submit; a throw after it may follow a request that left.
  let submitted = false;
  try {
    const payload = {
      from: request.from,
      to: [request.to[0]],
      subject: request.subject,
      html: request.html,
      text: request.text,
      replyTo: request.replyTo,
    };
    submitted = true;
    const result = await client.emails.send(payload, { idempotencyKey });
    if (result.error) {
      return {
        kind: 'provider_error',
        statusCode: typeof result.error.statusCode === 'number' ? result.error.statusCode : null,
        providerErrorClass: frozenDispatchClassName(result.error.name),
      };
    }
    const id = result.data?.id;
    if (typeof id !== 'string' || !FROZEN_DISPATCH_MESSAGE_ID_RE.test(id)) return { kind: 'no_message_id' };
    return { kind: 'accepted', id };
  } catch (error) {
    if (!submitted) return { kind: 'not_submitted', cause: 'argument_invalid' };
    let errorClass = 'unknown';
    try {
      errorClass = frozenDispatchClassName(error instanceof Error ? error.name : typeof error);
    } catch {
      // A hostile getter is still a submitted request; the class stays unknown.
    }
    return { kind: 'submit_threw', errorClass };
  }
}

// ── Lifecycle email builders ──────────────────────────────────────────────────

export function buildPreviewReadyEmail(
  order: OrderRecord,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = order.childName;

  const isDigital = order.bookFormat === 'digital';
  const subject = isDigital
    ? `${name}'s Hero Story Book is ready ✨`
    : `${name}'s storybook preview is ready`;

  const headingText = isDigital
    ? `${escapeHtml(name)}'s book is complete ✨`
    : `${escapeHtml(name)}'s preview is ready to review`;

  const bodyText = isDigital
    ? `Your personalized story is done. We're sending the PDF to you now — watch your inbox. If it doesn't arrive in a few minutes, check your spam folder or reply to this email and we'll resend it immediately.`
    : `We've put together a digital preview of ${escapeHtml(name)}'s book. Look for our separate "proof is ready" email — it has the link to review each illustrated page and approve the book before printing. If you don't see it within a few minutes, check your spam folder or reply here and we'll resend it.`;

  const nextStepText = isDigital
    ? ''
    : `<p style="margin:0 0 12px;color:#6b7280;font-size:14px;">Once approved: we print and ship in 5–7 business days.</p>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${headingText}</h1>
      <p style="margin:0 0 16px;">${bodyText}</p>
      ${nextStepText}
      <p style="margin:0 0 12px;">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Order ID: ${escapeHtml(order.id)} · Hero Story Books</p>
    </div>
  `;

  const textLines = isDigital
    ? [
        `${name}'s Hero Story Book is ready ✨`,
        '',
        `Your personalized story is done. We're sending the PDF to you now — watch your inbox.`,
        `If it doesn't arrive in a few minutes, check your spam folder or reply and we'll resend it.`,
        '',
        `Questions? ${supportEmail}`,
        `Order ID: ${order.id}`,
      ]
    : [
        `${name}'s storybook preview is ready`,
        '',
        `We've put together a digital preview of ${name}'s book.`,
        `Look for our separate "proof is ready" email — it has the link to review each illustrated page and approve the book before printing.`,
        `If you don't see it within a few minutes, check your spam folder or reply here and we'll resend it.`,
        '',
        `Once approved: printed and shipped in 5–7 business days.`,
        '',
        `Questions? ${supportEmail}`,
        `Order ID: ${order.id}`,
      ];

  return { subject, html, text: textLines.join('\n') };
}

export function buildPrintInProductionEmail(
  order: OrderRecord,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = order.childName;
  const formatLabel = order.formatLabel;

  const subject = `${name}'s book is in production`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${escapeHtml(name)}'s ${escapeHtml(formatLabel)} is printing now 🖨️</h1>
      <p style="margin:0 0 16px;">The approved proof has been sent to the printer. ${escapeHtml(name)}'s book is in production — we'll send another update when it ships.</p>
      <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:16px;padding:20px;margin-bottom:20px;">
        <p style="margin:0 0 8px;"><strong>Format:</strong> ${escapeHtml(formatLabel)}</p>
        <p style="margin:0 0 8px;"><strong>Expected shipping:</strong> 5–7 business days</p>
        <p style="margin:0;"><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      </div>
      <p style="margin:0 0 12px;">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Hero Story Books · Personalized with care</p>
    </div>
  `;

  const text = [
    `${name}'s ${formatLabel} is printing now`,
    '',
    `The approved proof is in production. We'll send another update when it ships.`,
    '',
    `Format: ${formatLabel}`,
    `Expected shipping: 5–7 business days`,
    `Order ID: ${order.id}`,
    '',
    `Questions? ${supportEmail}`,
  ].join('\n');

  return { subject, html, text };
}

export function buildShippedEmail(
  order: OrderRecord,
  options: { supportEmail?: string; trackingNumber?: string; trackingUrl?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const { trackingNumber, trackingUrl } = options;
  const name = order.childName;
  const formatLabel = order.formatLabel;

  const subject = `${name}'s storybook has shipped 📦`;

  const trackingHtml = trackingNumber
    ? trackingUrl
      ? `<p style="margin:0 0 12px;"><strong>Tracking:</strong> <a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingNumber)}</a></p>`
      : `<p style="margin:0 0 12px;"><strong>Tracking number:</strong> ${escapeHtml(trackingNumber)}</p>`
    : `<p style="margin:0 0 12px;color:#6b7280;">Tracking information will be provided by the carrier — watch for a separate notification.</p>`;

  const trackingText = trackingNumber
    ? trackingUrl
      ? `Tracking: ${trackingNumber} — ${trackingUrl}`
      : `Tracking number: ${trackingNumber}`
    : `Tracking information will be provided by the carrier.`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${escapeHtml(name)}'s storybook is on its way 📦</h1>
      <p style="margin:0 0 16px;">${escapeHtml(name)}'s ${escapeHtml(formatLabel)} has shipped and is headed to you.</p>
      <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:16px;padding:20px;margin-bottom:20px;">
        <p style="margin:0 0 8px;"><strong>Format:</strong> ${escapeHtml(formatLabel)}</p>
        <p style="margin:0 0 8px;"><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      </div>
      ${trackingHtml}
      <p style="margin:0 0 12px;">If anything looks wrong when it arrives, reply to this email within 7 days and we'll make it right.</p>
      <p style="margin:0 0 12px;">Questions? <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Proof approval before print · Hero Story Books</p>
    </div>
  `;

  const text = [
    `${name}'s storybook has shipped 📦`,
    '',
    `${name}'s ${formatLabel} is on its way to you.`,
    '',
    `Format: ${formatLabel}`,
    `Order ID: ${order.id}`,
    trackingText,
    '',
    `If anything looks wrong when it arrives, reply within 7 days and we'll make it right.`,
    `Questions? ${supportEmail}`,
  ].join('\n');

  return { subject, html, text };
}

// ── Lifecycle email dispatcher ────────────────────────────────────────────────

export async function sendLifecycleEmail(
  order: OrderRecord,
  options: { trackingNumber?: string; trackingUrl?: string; idempotencyKeyBase?: string } = {},
) {
  const supportEmail = getSupportEmail();

  let email: { subject: string; html: string; text: string } | null = null;

  switch (order.status) {
    case 'preview_ready':
      email = buildPreviewReadyEmail(order, { supportEmail });
      break;
    case 'print_in_production':
      if (!isPrintFormat(order)) {
        return { skipped: true as const, reason: 'not_print_format' };
      }
      email = buildPrintInProductionEmail(order, { supportEmail });
      break;
    case 'shipped':
      if (!isPrintFormat(order)) {
        return { skipped: true as const, reason: 'not_print_format' };
      }
      email = buildShippedEmail(order, { supportEmail, ...options });
      break;
    default:
      return { skipped: true as const, reason: 'no_lifecycle_email_for_status' };
  }

  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { skipped: true as const, reason: 'missing_resend_api_key' };
  }

  const resend = new Resend(apiKey);
  return sendWithFallback(
    resend,
    `Lifecycle email for ${order.id} status ${order.status}`,
    {
      from: getOrderSenderEmail(),
      to: [order.email],
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: supportEmail,
    },
    options.idempotencyKeyBase ? {
      primaryIdempotencyKey: `${options.idempotencyKeyBase}-primary`,
      fallbackIdempotencyKey: `${options.idempotencyKeyBase}-fallback`,
    } : {},
  );
}

// ── Fulfillment-specific emails ───────────────────────────────────────────────

export function buildDigitalDeliveryEmail(
  order: OrderRecord,
  options: {
    pdfUrl: string;
    reviewUrl?: string;
    supportEmail?: string;
    printUpgrade?: {
      checkoutUrl: string;
      targetLabel: string;
      amountCents: number;
    };
  },
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = order.childName;
  const subject = `${name}'s storybook is ready — download inside ✨`;
  const reviewHtml = options.reviewUrl
    ? `<p style="margin:0 0 16px;">Your personalized storybook is ready. Open the private review page to check every page, request wording or image changes, and acknowledge the current proof.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(options.reviewUrl)}" style="background:#D4AF37;color:#1F3A5F;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 32px;border-radius:12px;display:inline-block;">📖 Review ${escapeHtml(name)}'s Storybook</a>
      </div>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">Private review link: ${escapeHtml(options.reviewUrl)}</p>`
    : '<p style="margin:0 0 16px;">Your personalized storybook PDF is ready.</p>';
  const upgradeDollars = options.printUpgrade
    ? (options.printUpgrade.amountCents / 100).toFixed(2)
    : null;
  const upgradeHtml = options.printUpgrade
    ? `<div style="margin:28px 0;padding:20px;border:1px solid #e5d7a8;border-radius:12px;background:#fffbeb;">
        <h2 style="font-size:20px;color:#1F3A5F;margin:0 0 8px;">Want a printed keepsake too?</h2>
        <p style="margin:0 0 14px;">Add a ${escapeHtml(options.printUpgrade.targetLabel)} for $${upgradeDollars} plus shipping and applicable tax.</p>
        <a href="${escapeHtml(options.printUpgrade.checkoutUrl)}" style="background:#1F3A5F;color:#fff;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:10px;display:inline-block;">View print upgrade</a>
        <p style="margin:14px 0 0;color:#6b7280;font-size:13px;">Optional: your digital book remains yours either way. Nothing is printed until payment, proof approval, print QA, and our final print-go review are complete. Shipping timing is confirmed separately.</p>
      </div>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${escapeHtml(name)}'s book is done ✨</h1>
      ${reviewHtml}
      <p style="margin:0 0 12px;">Direct PDF: <a href="${escapeHtml(options.pdfUrl)}">Download ${escapeHtml(name)}'s Storybook</a></p>
      ${upgradeHtml}
      <p style="margin:0 0 12px;">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Order ID: ${escapeHtml(order.id)} · Proof approval before print</p>
    </div>
  `;

  const text = [
    `${name}'s storybook is ready ✨`,
    '',
    ...(options.reviewUrl ? [`Private review page: ${options.reviewUrl}`] : []),
    `Direct PDF download: ${options.pdfUrl}`,
    ...(options.printUpgrade ? [
      '',
      `Optional print upgrade: ${options.printUpgrade.targetLabel} for $${upgradeDollars} plus shipping and applicable tax.`,
      `View the upgrade: ${options.printUpgrade.checkoutUrl}`,
      'Your digital book remains yours either way. Nothing is printed until payment, proof approval, print QA, and final print-go review are complete. Shipping timing is confirmed separately.',
    ] : []),
    '',
    `Questions? ${supportEmail}`,
    `Order ID: ${order.id}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendDigitalDeliveryEmail(
  order: OrderRecord,
  options: {
    pdfUrl: string;
    reviewUrl?: string;
    idempotencyKeyBase?: string;
    printUpgrade?: {
      checkoutUrl: string;
      targetLabel: string;
      amountCents: number;
    };
  },
) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true as const, reason: 'missing_resend_api_key' };

  const resend = new Resend(apiKey);
  const supportEmail = getSupportEmail();
  const email = buildDigitalDeliveryEmail(order, {
    pdfUrl: options.pdfUrl,
    reviewUrl: options.reviewUrl,
    printUpgrade: options.printUpgrade,
    supportEmail,
  });

  return sendWithFallback(resend, `Digital delivery email for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  }, options.idempotencyKeyBase ? {
    primaryIdempotencyKey: `${options.idempotencyKeyBase}-primary`,
    fallbackIdempotencyKey: `${options.idempotencyKeyBase}-fallback`,
  } : {});
}

export function buildProofReadyEmail(
  order: OrderRecord,
  options: {
    /** Primary CTA — the customer review surface (`/review/<id>?token=...`).
     *  This is the only path that drives per-page accept, proof acknowledgment,
     *  and the server-gated whole-book approval. */
    reviewUrl: string;
    /** Secondary fallback — direct PDF link, for customers who only want to
     *  glance at the proof. Approval is NOT possible from this URL. */
    proofUrl: string;
    supportEmail?: string;
  },
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = order.childName;
  const subject = `${name}'s proof is ready — please review`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${escapeHtml(name)}'s book is ready to review 📖</h1>
      <p style="margin:0 0 16px;">We've created ${escapeHtml(name)}'s personalized storybook. Open the review page to look through each illustrated page, request changes if anything's off, then approve to send it to print.</p>
      <div style="text-align:center;margin:20px 0;">
        <a href="${escapeHtml(options.reviewUrl)}" style="background:#D4AF37;color:#1F3A5F;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 32px;border-radius:12px;display:inline-block;">
          📖 Review &amp; Approve ${escapeHtml(name)}'s Book
        </a>
      </div>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">On the review page you'll see every illustrated page, the full proof PDF, and the approval button — approval only unlocks after you've reviewed the proof.</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">Prefer to glance at just the proof PDF first? <a href="${escapeHtml(options.proofUrl)}" style="color:#1F3A5F;">View proof PDF</a> (you'll still need the review page to approve).</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;"><strong>Revision policy:</strong> review the full proof, then send one complete list. One consolidated revision round is included, followed by a final check limited to anything we missed from that request. We also correct genuine identity, anatomy, text, and continuity errors we introduced.</p>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">New photos, characters, scenes, major story changes, or a new creative direction after production begins require a $19 restart fee and reset the timeline. Once approved, later changes require a paid restart and cannot be made after printing begins.</p>
      <p style="margin:0 0 12px;">Questions? <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Order ID: ${escapeHtml(order.id)}</p>
    </div>
  `;

  const text = [
    `${name}'s proof is ready`,
    '',
    `Review and approve here: ${options.reviewUrl}`,
    `(The review page is where you check each page, acknowledge the proof, and approve.)`,
    '',
    `Proof PDF only (no approval): ${options.proofUrl}`,
    '',
    `Revision policy: review the full proof, then send one complete list. One consolidated revision round is included, followed by a final check limited to anything we missed from that request. We also correct genuine identity, anatomy, text, and continuity errors we introduced.`,
    `New photos, characters, scenes, major story changes, or a new creative direction after production begins require a $19 restart fee and reset the timeline. Once approved, later changes require a paid restart and cannot be made after printing begins.`,
    `Once approved, we'll print and ship in 5–7 business days.`,
    '',
    `Questions? ${supportEmail}`,
    `Order ID: ${order.id}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendProofReadyEmail(
  order: OrderRecord,
  options: { reviewUrl: string; proofUrl: string; idempotencyKeyBase?: string },
) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true as const, reason: 'missing_resend_api_key' };

  const resend = new Resend(apiKey);
  const supportEmail = getSupportEmail();
  const email = buildProofReadyEmail(order, { ...options, supportEmail });

  return sendWithFallback(resend, `Proof ready email for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  }, options.idempotencyKeyBase ? {
    primaryIdempotencyKey: `${options.idempotencyKeyBase}-primary`,
    fallbackIdempotencyKey: `${options.idempotencyKeyBase}-fallback`,
  } : {});
}

// ── Operator alert ────────────────────────────────────────────────────────────

export async function sendOperatorFailureAlert(order: OrderRecord, lastError: string) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true as const, reason: 'missing_resend_api_key' };

  const operatorEmail = process.env.HSB_OPERATOR_EMAIL || getSupportEmail();
  const resend = new Resend(apiKey);

  const subject = `[ACTION REQUIRED] Order ${order.id} failed fulfillment`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;">
      <h2 style="color:#dc2626;">Fulfillment failed — manual review needed</h2>
      <p><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.email)}</p>
      <p><strong>Child:</strong> ${escapeHtml(order.childName)}</p>
      <p><strong>Format:</strong> ${escapeHtml(order.formatLabel)}</p>
      <p><strong>Last error:</strong></p>
      <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;">${escapeHtml(lastError.slice(0, 500))}</pre>
      <p>The order is now in <strong>failed_manual_review</strong> state. Resolve and re-trigger fulfillment manually.</p>
    </div>
  `;

  return sendWithFallback(resend, `Operator failure alert for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [operatorEmail],
    subject,
    html,
    text: `Order ${order.id} (${order.email}) failed fulfillment after max retries.\n\nLast error: ${lastError.slice(0, 500)}\n\nStatus: failed_manual_review`,
  });
}

export interface RegenManualReviewAlertArgs {
  pageIndex: number;
  regenerateCount: number;
  latestFeedback: string;
}

export async function sendRegenManualReviewAlert(
  order: OrderRecord,
  args: RegenManualReviewAlertArgs,
) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true as const, reason: 'missing_resend_api_key' };

  const operatorEmail = process.env.HSB_OPERATOR_EMAIL || getSupportEmail();
  const resend = new Resend(apiKey);
  const subject = `[REVIEW] ${order.childName} page ${args.pageIndex + 1} hit ${args.regenerateCount} regenerations`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;">
      <h2 style="color:#b45309;">Page hit manual-review threshold</h2>
      <p><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.email)}</p>
      <p><strong>Child:</strong> ${escapeHtml(order.childName)}</p>
      <p><strong>Page:</strong> ${args.pageIndex + 1}</p>
      <p><strong>Regenerations:</strong> ${args.regenerateCount}</p>
      <p><strong>Latest feedback:</strong></p>
      <pre style="background:#f3f4f6;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap;">${escapeHtml((args.latestFeedback || '(no text)').slice(0, 500))}</pre>
      <p>Customer is iterating heavily on this page. Reach out and help personally.</p>
    </div>
  `;
  const text = [
    `Page ${args.pageIndex + 1} hit ${args.regenerateCount} regenerations`,
    `Order: ${order.id}`,
    `Customer: ${order.email} (${order.childName})`,
    `Latest feedback: ${(args.latestFeedback || '(no text)').slice(0, 500)}`,
  ].join('\n');

  return sendWithFallback(resend, `Regeneration manual-review alert for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [operatorEmail],
    subject,
    html,
    text,
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
