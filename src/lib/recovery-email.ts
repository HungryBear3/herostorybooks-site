import { Resend } from 'resend';

import type { RecoveryLead } from './recovery.ts';
import { getOrderSenderEmail, getSupportEmail } from './order-email.ts';

const CHECKOUT_URL = 'https://www.herostorybooks.com/checkout';

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildAbandonedCheckoutEmail(
  lead: RecoveryLead,
  options: { supportEmail?: string } = {},
) {
  const supportEmail = options.supportEmail || getSupportEmail();
  const name = lead.childName ? escapeHtml(lead.childName) : 'your little one';
  const hasMeta = Boolean(lead.childName || lead.theme || lead.bookFormat);

  const contextLine = hasMeta
    ? `You were working on ${lead.childName ? `a book for <strong>${name}</strong>` : 'a personalized storybook'}${lead.theme ? ` — the <em>${escapeHtml(lead.theme)}</em> adventure` : ''}${lead.bookFormat ? ` (${escapeHtml(lead.bookFormat)} edition)` : ''}.`
    : 'You started building a personalized storybook and got partway through.';

  const subject = lead.childName
    ? `${lead.childName}'s storybook is still waiting`
    : 'Your storybook is still waiting';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1f2937;line-height:1.6;">
      <h1 style="font-size:24px;color:#1F3A5F;margin-bottom:12px;">Your storybook is ready to finish ✨</h1>
      <p style="margin:0 0 14px;">${contextLine}</p>
      <p style="margin:0 0 20px;">When you are ready, you can return to the details you were sharing. We create a private digital proof first, and nothing enters print until you approve the full proof.</p>
      <a href="${CHECKOUT_URL}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:600;">Finish the book</a>
      <p style="margin:24px 0 0;font-size:14px;color:#6b7280;">Questions? Reply to this email or reach us at <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1F3A5F;">${escapeHtml(supportEmail)}</a>.</p>
    </div>
  `.trim();

  const text = [
    subject,
    '',
    contextLine.replace(/<[^>]+>/g, ''),
    '',
    `When you are ready, return to the details you were sharing.`,
    `We create a private digital proof first, and nothing enters print until you approve the full proof.`,
    `Finish here: ${CHECKOUT_URL}`,
    '',
    `Questions? Email ${supportEmail}`,
  ].join('\n');

  return { subject, html, text };
}

export async function sendAbandonedCheckoutEmail(lead: RecoveryLead): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const resend = new Resend(apiKey);
  const { subject, html, text } = buildAbandonedCheckoutEmail(lead);

  const result = await resend.emails.send({
    from: getOrderSenderEmail(),
    to: lead.email,
    subject,
    html,
    text,
  });

  if (result.error) throw new Error(`Resend error: ${result.error.message}`);
  return { id: result.data!.id };
}
