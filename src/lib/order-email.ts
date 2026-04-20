import { Resend } from 'resend';

import type { OrderRecord } from './orders';

const DEFAULT_SUPPORT_EMAIL = 'hello@herostorybooks.com';
const DEFAULT_FROM_EMAIL = 'Hero Story Books <onboarding@resend.dev>';

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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
