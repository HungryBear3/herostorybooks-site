import { Resend } from 'resend';

import type { OrderRecord } from './orders';
import { canEmailCustomer } from './qa-lifecycle.ts';

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

  return { skipped: false as const, id: result.data?.id ?? null };
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
) {
  const primary = await resend.emails.send(payload);
  if (!primary.error) {
    return assertResendSuccess(primary, context, payload.from);
  }

  const fallback = getFallbackSenderEmail();
  if (fallback && fallback !== payload.from && isDomainNotVerifiedError(primary.error)) {
    console.warn(
      `[order-email] ${context}: primary sender ${payload.from} unverified — retrying with HSB_EMAIL_FROM_FALLBACK=${fallback}`,
    );
    const retry = await resend.emails.send({ ...payload, from: fallback });
    return assertResendSuccess(retry, context, fallback);
  }

  // No fallback available, or the failure was not a domain issue. Surface
  // the actionable error message and throw.
  return assertResendSuccess(primary, context, payload.from);
}

function getPublicBaseUrl() {
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'https://herostorybooks.com';
}

function buildStatusUrl(orderId: string) {
  return `${getPublicBaseUrl()}/status/${encodeURIComponent(orderId)}`;
}

export function buildOrderConfirmationEmail(
  order: OrderRecord,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const previewNote = order.bookFormat === 'digital'
    ? 'Your digital proof is usually ready within 2 business days; your final PDF is delivered after approval.'
    : 'Your digital preview will arrive first so you can approve it before it prints.';
  const statusUrl = buildStatusUrl(order.id);

  const subject = `${order.childName}'s Hero Story Books order is in`;
  const detailRows = [
    ['Child name', order.childName],
    ['Format', order.formatLabel],
    ['Delivery', order.deliveryExpectation],
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
      <div style="text-align:center;margin:20px 0;">
        <a href="${escapeHtml(statusUrl)}" style="background:#D4AF37;color:#1F3A5F;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 32px;border-radius:12px;display:inline-block;">Track your order</a>
      </div>
      <p style="margin:0 0 12px;">If you have questions, just reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Proof approval before print · Personalized with care by Hero Story Books</p>
    </div>
  `;

  const text = [
    `We received ${order.childName}'s storybook order ✨`,
    '',
    `Child name: ${order.childName}`,
    `Format: ${order.formatLabel}`,
    `Delivery: ${order.deliveryExpectation}`,
    `Order ID: ${order.id}`,
    '',
    previewNote,
    `Track your order: ${statusUrl}`,
    `Questions? ${supportEmail}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendOrderConfirmationEmail(order: OrderRecord) {
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { skipped: true as const, reason: 'missing_resend_api_key' };
  }

  const resend = new Resend(apiKey);
  const supportEmail = getSupportEmail();
  const email = buildOrderConfirmationEmail(order, { supportEmail });
  return sendWithFallback(resend, `Order confirmation email for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  });
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
  options: { trackingNumber?: string; trackingUrl?: string } = {},
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
  );
}

// ── Fulfillment-specific emails ───────────────────────────────────────────────

export function buildDigitalDeliveryEmail(
  order: OrderRecord,
  options: { pdfUrl: string; supportEmail?: string } = { pdfUrl: '' },
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = order.childName;
  const subject = `${name}'s storybook is ready — download inside ✨`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:28px;color:#1F3A5F;margin-bottom:12px;">${escapeHtml(name)}'s book is done ✨</h1>
      <p style="margin:0 0 16px;">Your personalized storybook is ready. Click below to download your PDF.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(options.pdfUrl)}" style="background:#D4AF37;color:#1F3A5F;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 32px;border-radius:12px;display:inline-block;">
          📖 Download ${escapeHtml(name)}'s Storybook
        </a>
      </div>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">If the button doesn't work, copy this link: ${escapeHtml(options.pdfUrl)}</p>
      <p style="margin:0 0 12px;">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Order ID: ${escapeHtml(order.id)} · Proof approval before print</p>
    </div>
  `;

  const text = [
    `${name}'s storybook is ready ✨`,
    '',
    `Download your PDF here: ${options.pdfUrl}`,
    '',
    `Questions? ${supportEmail}`,
    `Order ID: ${order.id}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendDigitalDeliveryEmail(
  order: OrderRecord,
  options: { pdfUrl: string },
) {
  // QA gate: never email a customer their proof/delivery unless QA passed.
  const qaGate = canEmailCustomer(order);
  if (!qaGate.allowed) return { skipped: true as const, reason: 'qa_not_passed', detail: qaGate.reason };
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true as const, reason: 'missing_resend_api_key' };

  const resend = new Resend(apiKey);
  const supportEmail = getSupportEmail();
  const email = buildDigitalDeliveryEmail(order, { pdfUrl: options.pdfUrl, supportEmail });

  return sendWithFallback(resend, `Digital delivery email for ${order.id}`, {
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  });
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
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">If you'd like any changes, request them on the review page or reply to this email. Once approved, we'll print and ship in 5–7 business days.</p>
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
    `If you'd like changes, request them on the review page or reply to this email.`,
    `Once approved, we'll print and ship in 5–7 business days.`,
    '',
    `Questions? ${supportEmail}`,
    `Order ID: ${order.id}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendProofReadyEmail(
  order: OrderRecord,
  options: { reviewUrl: string; proofUrl: string },
) {
  // QA gate: never email a customer their proof unless QA passed.
  const qaGate = canEmailCustomer(order);
  if (!qaGate.allowed) return { skipped: true as const, reason: 'qa_not_passed', detail: qaGate.reason };
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
  });
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
