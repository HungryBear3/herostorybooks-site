import { Resend } from 'resend';

import type { OrderRecord } from './orders';

const DEFAULT_SUPPORT_EMAIL = 'hello@herostorybooks.com';
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

export function buildOrderConfirmationEmail(
  order: OrderRecord,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const previewNote = order.bookFormat === 'digital'
    ? 'Your PDF will be delivered to this email in about 15 minutes.'
    : 'Your digital preview will arrive first so you can approve it before it prints.';

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
      <p style="margin:0 0 12px;">If you have questions, just reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">7-day satisfaction guarantee · Personalized with care by Hero Story Books</p>
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
  const result = await resend.emails.send({
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  });

  return { skipped: false as const, id: result.data?.id ?? null };
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
    : `We've put together a digital preview of ${escapeHtml(name)}'s book so you can look it over before we send it to print. Reply to this email to view the preview and let us know if you'd like any changes — or give us the green light and we'll move it into production.`;

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
        `We've put together a digital preview of ${name}'s book so you can look it over before we print.`,
        `Reply to this email to view the preview. Let us know if you'd like changes or give us the go-ahead.`,
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
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">7-day satisfaction guarantee · Hero Story Books</p>
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
  const result = await resend.emails.send({
    from: getOrderSenderEmail(),
    to: [order.email],
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: supportEmail,
  });

  return { skipped: false as const, id: result.data?.id ?? null };
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
