// Prepare (or rotate) the customer at-cost print-upgrade offer for ONE order.
//
// Usage:
//   node --experimental-strip-types scripts/prepare-print-upgrade-offer.ts <orderId> \
//     --sha256 <approved-pdf-sha256> --pages <approved-page-count> [--label <file label>] [--ttl-days 14] [--json]
//
// Reads/writes the same store the live app uses (Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set; HSB_ORDER_STORE_DIR / tmp fallback locally).
// Prints the ONE-TIME chooser URL (only its hash is stored) and the email
// draft. It never sends email, never creates a Stripe Session, and never
// contacts a print provider. Sending is a separate, explicitly enabled step
// (see docs/runbooks/customer-print-upgrade-at-cost.md).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import { buildPrintUpgradeOfferEmail } from '../src/lib/print-upgrade-email.ts';
import { getSiteOrigin } from '../src/lib/site-url.ts';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main() {
  const orderId = process.argv[2];
  const sha = arg('--sha256');
  const pdfPath = arg('--pdf');
  const pages = Number.parseInt(arg('--pages') ?? '', 10);
  const label = arg('--label');
  const ttlDays = Number.parseFloat(arg('--ttl-days') ?? '14');
  const wantJson = process.argv.includes('--json');
  const purchaseKind = arg('--kind') === 'extra_copy' ? 'extra_copy' : 'upgrade';

  if (!orderId || orderId.startsWith('--') || (!sha && !pdfPath) || !Number.isInteger(pages)) {
    console.error('Usage: node --experimental-strip-types scripts/prepare-print-upgrade-offer.ts <orderId> (--sha256 <hex> | --pdf <path>) --pages <n> [--label <text>] [--ttl-days 14] [--json]');
    process.exit(2);
  }

  let approvedSourceSha256 = sha ?? '';
  if (pdfPath) {
    const computed = createHash('sha256').update(readFileSync(pdfPath)).digest('hex');
    if (sha && sha.toLowerCase() !== computed) {
      console.error(`SHA-256 mismatch: --sha256 ${sha} but ${pdfPath} hashes to ${computed}. Refusing.`);
      process.exit(1);
    }
    approvedSourceSha256 = computed;
  }

  const result = await prepareCustomerPrintUpgradeOffer(orderId, {
    purchaseKind,
    approvedSourceSha256,
    approvedSourcePageCount: pages,
    approvedSourceLabel: label,
    ttlMs: Math.round(ttlDays * 24 * 60 * 60 * 1000),
  });
  if (result.ok === false) {
    console.error(`Offer NOT prepared for ${orderId}: ${result.reason}`);
    process.exit(1);
  }
  const chooserUrl = `${getSiteOrigin()}${result.chooserPath}`;
  const draft = buildPrintUpgradeOfferEmail(result.order, { chooserUrl, expiresAt: result.offer.expiresAt });
  const out = {
    orderId,
    offerId: result.offer.offerId,
    expiresAt: result.offer.expiresAt,
    quotePageCounts: result.offer.quotePageCounts,
    chooserUrl,
    emailDraft: draft,
    sent: false,
    safety: 'Offer prepared only. No email sent, no Stripe Session, no print file, no provider call. The chooser URL is shown once; only its hash is stored.',
  };
  if (wantJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Offer ${out.offerId} prepared for ${orderId} (expires ${out.expiresAt})`);
  console.log(`Quote page counts: softcover ${out.quotePageCounts.classic}, hardcover ${out.quotePageCounts.premium}`);
  console.log('');
  console.log('ONE-TIME chooser URL (copy now; it is not stored):');
  console.log(chooserUrl);
  console.log('');
  console.log(`Email draft → to: ${draft.to}`);
  console.log(`subject: ${draft.subject}`);
  console.log('');
  console.log(draft.text);
  console.log('');
  console.log(out.safety);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
