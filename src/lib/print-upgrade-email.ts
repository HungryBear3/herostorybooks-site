/**
 * Customer digital-to-print upgrade — the OFFER EMAIL.
 *
 * `buildPrintUpgradeOfferEmail` is a pure draft. `sendPrintUpgradeOfferEmail`
 * sends it through Resend only when HSB_PRINT_UPGRADE_OFFER_EMAIL_ENABLED is
 * exactly "true", with a per-(order, offer) idempotency key so a retried
 * operator action can never deliver the same offer twice. Nothing here is
 * invoked automatically by checkout, webhook or fulfillment.
 */
import { Resend } from 'resend';

import type { OrderRecord } from './orders.ts';
import { getOrderSenderEmail, getSupportEmail } from './order-email.ts';

export const PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV = 'HSB_PRINT_UPGRADE_OFFER_EMAIL_ENABLED';

export interface PrintUpgradeOfferEmailInput {
  chooserUrl: string;
  expiresAt: string;
  supportEmail?: string;
}

export interface PrintUpgradeOfferEmailDraft {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function bookTitleFor(order: OrderRecord): string {
  return order.printTitle?.trim() || `${order.childName}'s Hero Story Book`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
}

export function buildPrintUpgradeOfferEmail(order: OrderRecord, input: PrintUpgradeOfferEmailInput): PrintUpgradeOfferEmailDraft {
  const supportEmail = input.supportEmail || getSupportEmail();
  const title = bookTitleFor(order);
  const name = order.childName;
  const expires = longDate(input.expiresAt);
  const extra = order.printUpgradeOffer?.purchaseKind === 'extra_copy';
  const subject = extra
    ? `Share ${name}'s approved book with family — extra copies at print cost`
    : `Want a printed copy of ${name}'s book? Pay only our print cost`;

  const paragraphs = [
    extra
      ? `Your approved book "${title}" can be shared as extra print copies for family or friends. This reuses the approved story; you are not buying digital production again.`
      : `Your digital book "${title}" is finished and approved. If you would like a printed keepsake, you can order one at exactly what our print provider charges us — no markup.`,
    `Choose a softcover or a hardcover, quantity, and shipping destination on your private page. The price is quoted live from our print provider and covers only print, shipping and handling, the provider's fulfillment fee, and any tax the provider charges. You see the exact total and delivery estimate before you pay.`,
    `After you pay, we prepare the print files for the format you choose and check them by hand. Nothing is printed automatically: we email you a final print proof to confirm, and we confirm again before it goes to print and when it ships.`,
    `Your digital book stays yours either way. This private link is for this order only and expires on ${expires}.`,
  ];

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f2937;line-height:1.5;">
      <h1 style="font-size:26px;color:#1F3A5F;margin-bottom:12px;">A printed copy of ${escapeHtml(name)}'s book, at our cost</h1>
      ${paragraphs.map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p)}</p>`).join('\n      ')}
      <div style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(input.chooserUrl)}" style="background:#D4AF37;color:#1F3A5F;font-weight:bold;font-size:16px;text-decoration:none;padding:14px 32px;border-radius:12px;display:inline-block;">Choose softcover or hardcover</a>
      </div>
      <p style="margin:0 0 12px;color:#6b7280;font-size:13px;">Private link: ${escapeHtml(input.chooserUrl)}</p>
      <p style="margin:0 0 12px;">Questions? Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Order ID: ${escapeHtml(order.id)}</p>
    </div>
  `;

  const text = [
    `A printed copy of ${name}'s book, at our cost`,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    `Choose softcover or hardcover (private link): ${input.chooserUrl}`,
    '',
    `Questions? ${supportEmail}`,
    `Order ID: ${order.id}`,
  ].join('\n');

  return { to: order.email, subject, html, text };
}

export interface PrintUpgradeOfferEmailTransport {
  send(
    payload: { from: string; to: string[]; subject: string; html: string; text: string; replyTo?: string },
    options?: { idempotencyKey?: string },
  ): Promise<{ data?: { id?: string | null } | null; error?: unknown }>;
}

export type SendPrintUpgradeOfferEmailResult =
  | { skipped: true; reason: 'print_upgrade_offer_email_disabled' | 'missing_resend_api_key' }
  | { skipped: false; id: string };

export function printUpgradeOfferEmailIdempotencyKey(orderId: string, offerId: string): string {
  return `print-upgrade-offer-${orderId}-${offerId}`;
}

export async function sendPrintUpgradeOfferEmail(
  order: OrderRecord,
  input: PrintUpgradeOfferEmailInput & { offerId: string },
  deps: { transport?: PrintUpgradeOfferEmailTransport } = {},
): Promise<SendPrintUpgradeOfferEmailResult> {
  if ((process.env[PRINT_UPGRADE_OFFER_EMAIL_ENABLED_ENV] ?? '').trim() !== 'true') {
    return { skipped: true, reason: 'print_upgrade_offer_email_disabled' };
  }
  const apiKey = process.env.HSB_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'missing_resend_api_key' };

  const draft = buildPrintUpgradeOfferEmail(order, input);
  const transport: PrintUpgradeOfferEmailTransport = deps.transport ?? {
    send: (payload, options) => new Resend(apiKey).emails.send(payload, options),
  };
  const result = await transport.send(
    { from: getOrderSenderEmail(), to: [draft.to], subject: draft.subject, html: draft.html, text: draft.text, replyTo: input.supportEmail || getSupportEmail() },
    { idempotencyKey: printUpgradeOfferEmailIdempotencyKey(order.id, input.offerId) },
  );
  if (result.error) {
    const message = typeof result.error === 'object' && result.error && 'message' in result.error
      ? String((result.error as { message: unknown }).message)
      : String(result.error);
    throw new Error(`Print upgrade offer email for ${order.id} failed: ${message.slice(0, 200)}`);
  }
  const id = result.data?.id;
  if (!id) throw new Error(`Print upgrade offer email for ${order.id} returned no provider message id; outcome requires reconciliation`);
  return { skipped: false, id };
}
