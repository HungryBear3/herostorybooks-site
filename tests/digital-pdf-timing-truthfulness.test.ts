/**
 * Digital PDF timing must match the digital fulfillment path.
 *
 * Traced behavior (src/lib/fulfillment.ts, runDigitalFulfillment):
 *   1. story + illustrations generate;
 *   2. ONE pdf is built and uploaded to `proofArtifactPath(proofVersion)`;
 *   3. the order commits `fulfillmentStatus:'complete'`, `status:'preview_ready'`,
 *      `storyArtifactUrl:<that pdf>`, `reviewStatus:'in_review'`;
 *   4. `sendDigitalDeliveryEmail` sends immediately with BOTH `reviewUrl` and a
 *      direct `pdfUrl` download.
 *
 * `approveWholeBook` (src/lib/page-review.ts) then sets `reviewStatus:'approved'`
 * and appends an audit event. It mints no artifact and unlocks no file.
 *
 * So for digital orders approval is ACCEPTANCE (and the refund boundary, and the
 * gate for print), never the first delivery of the PDF. Copy saying the customer
 * receives the high-resolution PDF only after approving is false, and this suite
 * is the standing lock on that.
 *
 * Scope note: this bans "approval unlocks the PDF". It deliberately still permits
 * accurate statements that approval accepts the book and gates printing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildDeliveryExpectation, createOrderRecord } from '../src/lib/orders.ts';
import { buildDigitalDeliveryEmail, buildOrderConfirmationEmail } from '../src/lib/order-email.ts';

const read = (p: string) => readFileSync(p, 'utf8');

/** Comments explain the rule; only customer-readable text is scanned. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Files carrying the claim that are NOT served, verified by importer count in
 * the reachability test below. They are left untouched on purpose: editing dead
 * components is out of scope for a truthfulness repair, and the reachability
 * assertion means wiring one up fails this suite instead of shipping the claim.
 */
const UNREACHABLE_WITH_STALE_CLAIM: Array<[string, string]> = [
  ['src/components/landing/FAQ.tsx', 'landing/FAQ'],
  ['src/components/landing/Pricing.tsx', 'landing/Pricing'],
  ['src/lib/pricing.ts', 'pricing-section'],
  ['src/lib/fathers-day.ts', 'FATHERS_DAY_OFFER'],
];
const EXCLUDED = new Set(UNREACHABLE_WITH_STALE_CLAIM.map(([file]) => file));

/**
 * Claims that approval is the first event delivering or unlocking the PDF.
 *
 * Each pattern requires BOTH an approval token and a file/delivery token in the
 * same sentence, so accurate copy like "nothing is printed until you approve"
 * and "approving accepts the book" does not match.
 */
const APPROVAL_FIRST_DELIVERY: Array<[string, RegExp]> = [
  ['approve → receive/get the PDF', /(once|after|when)\s+you\s+approve[^.]{0,140}\b(PDF|high[- ]res(olution)?\s+(book|file|copy)?|digital (book|file|download))\b/i],
  // The approval token must be the customer ACT of approving. The adjectival
  // compound "proof-approved" describes a sample that was already approved —
  // see the sample caption in editorial-site.tsx ("the same proof-approved book
  // that digital orders receive as a high-resolution PDF"), which is a true
  // statement about the sample, not a delivery-timing promise. The lookbehind
  // excludes it without excluding the file.
  ['approve then delivered/unlocked', /(?<!-)\b(you\s+approve[a-z]*|approving)\b[^.]{0,90}\b(receive|deliver|unlock|send|email)[a-z]*\b[^.]{0,70}\b(PDF|high[- ]res(olution)?)\b/i],
  ['PDF arrives after approval', /\b(PDF|high[- ]resolution\s+\w+)\b[^.]{0,90}\b(after|upon|once)\b[^.]{0,40}\bapprov/i],
  ['same-day delivery after approval', /\bapprov[a-z]*\b[^.]{0,80}\b(delivered|delivery)\b[^.]{0,40}\bsame[- ]day\b/i],
];

function servedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'admin' || entry === 'node_modules') continue;
        walk(full);
      } else if ((full.endsWith('.ts') || full.endsWith('.tsx')) && !EXCLUDED.has(full)) {
        out.push(full);
      }
    }
  };
  for (const root of ['src/app', 'src/components', 'src/lib']) walk(root);
  return out;
}

// ── 1. The behavior this copy must match ────────────────────────────────────

test('digital fulfillment persists the PDF and emails it before any approval', () => {
  const src = read('src/lib/fulfillment.ts');
  const completeIdx = src.indexOf("fulfillmentStatus: 'complete'");
  // The call site, not the import at the top of the file.
  const sendIdx = src.indexOf('await sendDigitalDeliveryEmail(');
  const approveIdx = src.indexOf('approveWholeBook');

  assert.ok(completeIdx > -1, 'digital path must still commit a complete state');
  assert.ok(sendIdx > -1, 'digital path must still send the delivery email');
  assert.ok(completeIdx < sendIdx, 'the PDF is persisted before the email is sent');
  assert.equal(approveIdx, -1, 'the digital delivery path must not wait on approval');
});

test('the digital delivery email carries the PDF itself, not just a review link', () => {
  const order = createOrderRecord(
    { childName: 'Ada', bookFormat: 'digital', email: 'ada@example.com' },
    { id: 'ord_timing_digital' },
  );
  const email = buildDigitalDeliveryEmail(order, {
    pdfUrl: 'https://example.invalid/proof.pdf',
    reviewUrl: 'https://example.invalid/review',
    supportEmail: 'support@herostorybooks.com',
  });
  for (const channel of [email.html, email.text] as const) {
    assert.ok(channel.includes('https://example.invalid/proof.pdf'), 'direct PDF link must be present');
    assert.ok(channel.includes('https://example.invalid/review'), 'review link must be present');
  }
  // Nothing in this email may condition the download on approving first.
  for (const [claim, pattern] of APPROVAL_FIRST_DELIVERY) {
    for (const channel of [email.html, email.text] as const) {
      assert.equal(channel.match(pattern)?.[0] ?? null, null, `delivery email makes an "${claim}" promise`);
    }
  }
});

test('approving mints no artifact — it records acceptance', () => {
  const src = read('src/lib/page-review.ts');
  const approve = src.slice(src.indexOf('export async function approveWholeBook'));
  assert.match(approve, /reviewStatus: 'approved'/, 'approval sets the accepted state');
  assert.ok(!/_upload\(|buildPdf\(|storyArtifactUrl:\s*[^,\s]/.test(approve.slice(0, 2000)),
    'approval must not build or attach a new artifact');
});

// ── 2. No served surface claims approval delivers the PDF ───────────────────

test('no served customer surface says the PDF arrives only after approval', () => {
  for (const file of servedSources()) {
    const src = withoutComments(read(file));
    for (const [claim, pattern] of APPROVAL_FIRST_DELIVERY) {
      const hit = src.match(pattern);
      assert.equal(hit?.[0] ?? null, null, `${file} makes an "${claim}" promise the digital path does not keep`);
    }
  }
});

test('customer emails do not claim the PDF arrives only after approval', () => {
  for (const bookFormat of ['digital', 'classic', 'premium']) {
    const order = createOrderRecord(
      { childName: 'Nia', bookFormat, email: 'nia@example.com' },
      { id: `ord_timing_${bookFormat}` },
    );
    const email = buildOrderConfirmationEmail(order, { supportEmail: 'support@herostorybooks.com' });
    for (const channel of [email.html, email.text] as const) {
      for (const [claim, pattern] of APPROVAL_FIRST_DELIVERY) {
        assert.equal(channel.match(pattern)?.[0] ?? null, null, `${bookFormat} confirmation email makes an "${claim}" promise`);
      }
    }
  }
});

test('the persisted digital delivery expectation states the PDF comes with the proof', () => {
  const expectation = buildDeliveryExpectation('digital');
  assert.match(expectation, /comes with it/i, 'must say the PDF arrives with the proof');
  assert.doesNotMatch(expectation, /after approval/i, 'must not gate the PDF on approval');
  assert.ok(!/ships/i.test(expectation), 'digital still has no shipping step');
});

// ── 3. Accurate approval statements are still allowed ───────────────────────

test('approval still gates printing, and that language is preserved', () => {
  const editorial = read('src/components/editorial-site.tsx');
  assert.match(editorial, /not printed until you approve/i, 'print-gating claim must survive');
  assert.match(read('src/app/checkout/checkout-form.tsx'), /Nothing prints until/i);
  // Print formats legitimately describe shipping as following approval.
  for (const format of ['classic', 'premium']) {
    assert.match(buildDeliveryExpectation(format), /After approval,[^.]*ships/i, `${format}: shipping still follows approval`);
  }
});

test('the digital refund boundary is unchanged — only its false rationale was removed', () => {
  const editorial = read('src/components/editorial-site.tsx');
  assert.match(editorial, /Digital orders are fully refundable up until you approve the proof/i,
    'the refund rule itself must not be weakened');
  assert.match(editorial, /Printed books are refundable up until you approve the proof for print/i);
});

// ── 4. The excluded files really are unreachable ────────────────────────────

test('files still carrying the stale claim are genuinely unserved', () => {
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) all.push(full);
    }
  };
  walk('src');

  for (const [file, symbol] of UNREACHABLE_WITH_STALE_CLAIM) {
    const importers = all.filter((f) => f !== file && read(f).includes(symbol));
    assert.deepEqual(
      importers, [],
      `${file} is now reachable via ${symbol}. Its approval-first PDF copy is stale and must be ` +
        'corrected before it can be served, or removed from this exclusion list.',
    );
  }
});
