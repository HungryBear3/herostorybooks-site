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
import {
  buildDigitalDeliveryEmail,
  buildOrderConfirmationEmail,
  buildPreviewReadyEmail,
  buildPrintInProductionEmail,
  buildProofReadyEmail,
  buildShippedEmail,
} from '../src/lib/order-email.ts';

const read = (p: string) => readFileSync(p, 'utf8');

/** Comments explain the rule; only customer-readable text is scanned. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // A `DEPRECATED_*` declaration holds retired strings for the express purpose
    // of detecting and replacing them (see renderDeliveryExpectation). Scanning
    // it would flag the suppression mechanism as the claim it suppresses.
    .replace(/const\s+DEPRECATED_[A-Z_]+[\s\S]*?\]\);/g, ' ');
}

/**
 * Files carrying the claim that are NOT served, verified by importer count in
 * the reachability test below. They are left untouched on purpose: editing dead
 * components is out of scope for a truthfulness repair, and the reachability
 * assertion means wiring one up fails this suite instead of shipping the claim.
 */
const UNREACHABLE_WITH_STALE_CLAIM: string[] = [
  'src/components/landing/FAQ.tsx',
  'src/components/landing/Pricing.tsx',
  'src/components/pricing-section.tsx',
];
const EXCLUDED = new Set([...UNREACHABLE_WITH_STALE_CLAIM, 'src/lib/pricing.ts']);

/**
 * Grammar of the banned claim.
 *
 * Rex's audit of d11cc20 blocked exactly because the previous patterns were
 * induced from the strings already found, so they encoded the same blind spot
 * twice: `PDF follows approval` has no after/upon/once, and
 * `approve … the Digital PDF arrives the same day` uses `arrives` rather than a
 * delivery verb the list knew. Both shipped green.
 *
 * Two changes fix that class of miss. First the vocabulary is enumerated by
 * ROLE (file / delivery / approval) instead of by remembered sentence. Second
 * the predicate is exported and driven by the fixture tables below, so the
 * grammar is tested directly rather than only against whatever the tree happens
 * to contain today.
 */
const FILE = String.raw`(?:the\s+)?(?:final\s+)?(?:high[- ]res(?:olution)?\s+)?(?:PDFs?|digital\s+(?:book|file|copy|download))`;
const ACCESS = String.raw`(?:access(?:ible)?|available|unlock(?:ed|s)?|release(?:d|s)?|provide(?:d|s)?|(?:send(?:ing|s)?|sent)|email(?:ed|s)?|deliver(?:ed|y|s)?|download|receive(?:d|s)?|grant(?:ed|s)?|arriv(?:e|es|ed)|comes?|becomes?\s+accessible|made?\s+accessible)`;
const APPROVAL = String.raw`(?:approv(?:e|es|ed|al|als|ing)|accept(?:ed|ance|s|ing)?)`;

/**
 * Each entry is (label, pattern). A clause matching ANY of them asserts that
 * approval precedes the customer getting the file, which the digital path
 * contradicts. Patterns never require the pronoun "you" — HSB-PDF-1 slipped
 * through partly on that assumption.
 */
const APPROVAL_FIRST_DELIVERY: Array<[string, RegExp]> = [
  // "Once you approve …, you receive the final high-resolution PDF"
  ['approval-first, then the file', new RegExp(String.raw`(?:once|after|when|upon|following)\s+(?:you\s+|your\s+)?${APPROVAL}[^.;!?]{0,140}${FILE}`, 'i')],
  // "approve … the Digital PDF arrives the same day"  (HSB-PDF-2)
  ['approval then file arrives', new RegExp(String.raw`(?<!-)\b${APPROVAL}\b[^.;!?]{0,110}${FILE}[^.;!?]{0,70}\b${ACCESS}\b`, 'i')],
  // "Approval unlocks the high-resolution PDF" — approval as the subject.
  ['approval delivers the file', new RegExp(String.raw`(?<!-)\b${APPROVAL}\b[^.;!?]{0,60}\b(?:grants?\s+access\s+to|makes?|unlocks?|releases?|sends?|emails?|delivers?|provides?)\b[^.;!?]{0,60}${FILE}`, 'i')],
  // "The digital file is emailed after approval" — the connector is REQUIRED.
  // Without it the pattern degrades to mere co-occurrence and flags true copy
  // like "the full PDF comes with it, and you approve when it is right".
  ['file delivered after approval', new RegExp(String.raw`${FILE}[^.;!?]{0,90}\b${ACCESS}\b[^.;!?]{0,50}(?:\b(?:after|upon|once|following|post)\b[^.;!?]{0,20}|\bon\s+)(?:your\s+|the\s+)?${APPROVAL}\b`, 'i')],
  // "The final digital PDF follows approval" (HSB-PDF-1) — "follows" encodes the
  // ordering by itself, so it needs no connector.
  ['file follows approval', new RegExp(String.raw`${FILE}[^.;!?]{0,40}\bfollows?\b[^.;!?]{0,20}(?:your\s+|the\s+)?${APPROVAL}\b`, 'i')],
  // "PDF is delivered the same day after approval"
  ['same-day file on approval', new RegExp(String.raw`(?:${APPROVAL}[^.;!?]{0,90}${FILE}|${FILE}[^.;!?]{0,90}${APPROVAL})[^.;!?]{0,40}same[- ]day`, 'i')],
  ['approval grants access to file', new RegExp(String.raw`\b${APPROVAL}\b[^.;!?]{0,40}\b(?:grants?\s+access\s+to|makes?)\b[^.;!?]{0,30}${FILE}[^.;!?]{0,20}\b(?:accessible|available)?\b`, 'i')],
  ['file becomes accessible after approval', new RegExp(String.raw`${FILE}[^.;!?]{0,40}\bbecomes?\s+accessible\b[^.;!?]{0,30}(?:after|upon|following)\s+(?:your\s+|the\s+)?${APPROVAL}\b`, 'i')],
];

/**
 * Clause-level scanning. Splitting on sentence and semicolon boundaries is what
 * keeps a true compound like
 *   "Digital orders receive the full PDF with the proof email; approving accepts the book."
 * from reading as one approval-plus-file claim.
 */
export function clausesOf(text: string): string[] {
  // `·` is this codebase's inline list separator ("Proof ready in X · Softcover
  // ships 5–7 business days after approval · Digital PDF included"). Each bullet
  // is an independent fact, so treating the whole run as one clause would read
  // an accurate print-shipping bullet and an accurate PDF bullet as a single
  // approval-then-PDF claim.
  return text.split(/[.;!?\n·]+/g).map((c) => c.trim()).filter(Boolean);
}

/** Returns the label of the first banned construction found, or null. */
export function bannedTimingClaim(text: string): string | null {
  for (const clause of clausesOf(text)) {
    for (const [label, pattern] of APPROVAL_FIRST_DELIVERY) {
      if (pattern.test(clause)) return label;
    }
  }
  return null;
}

/** Exact constructions that MUST be caught. Includes every string Rex found. */
const BANNED_FIXTURES: Array<[string, string]> = [
  ['HSB-PDF-1 exact', 'The final digital PDF follows approval.'],
  ['HSB-PDF-1 short', 'PDF follows approval'],
  ['HSB-PDF-2 exact', 'Approve your proof (usually in 2–3 business days) and the Digital PDF arrives the same day — no shipping.'],
  ['approve then PDF arrives', 'Approve the proof and the PDF arrives.'],
  ['approve then digital file arrives', 'Approve the proof and the digital file arrives.'],
  ['original thank-you claim', 'Once you approve the proof, you receive the final high-resolution PDF for digital orders.'],
  ['original expectation', 'Digital proof usually ready in 2–3 business days; final PDF delivered after approval.'],
  ['review-client claim', 'This opens the complete storybook PDF we will send to your inbox once you approve.'],
  ['no pronoun, upon approval', 'The high-resolution PDF is released upon approval.'],
  ['no pronoun, after approval', 'The digital file is emailed after approval.'],
  ['unlock phrasing', 'Approval unlocks the high-resolution PDF.'],
  ['following approval', 'Following approval, the digital download becomes available.'],
  ['same-day after approval', 'After approval, digital PDFs are delivered the same day.'],
  ['sent on approval', 'The PDF is sent on approval.'],
];

const EXACT_TIMING_FIXTURES: Array<{ label: string; sentence: string; probes: string[] }> = [
  {
    label: 'approval grants access to the final PDF',
    sentence: 'Approval grants access to the final PDF.',
    probes: [
      'Customer approval grants access to the final PDF.',
      'Acceptance grants access to the final PDF.',
      'Approval grants access to the high-resolution PDF download.',
    ],
  },
  {
    label: 'digital file provided after approval',
    sentence: 'The digital file is provided after approval.',
    probes: [
      'The digital file is provided after acceptance.',
      'The digital file is delivered after approval.',
      'The digital download is emailed after approval.',
    ],
  },
  {
    label: 'PDF becomes accessible after approval',
    sentence: 'The PDF becomes accessible after approval.',
    probes: [
      'The final PDF becomes accessible after acceptance.',
      'The PDF becomes available after approval.',
      'The high-resolution PDF becomes accessible following approval.',
    ],
  },
  {
    label: 'approval makes digital download accessible',
    sentence: 'Approval makes the digital download accessible.',
    probes: [
      'Approval makes the PDF accessible.',
      'Acceptance makes the digital file accessible.',
      'Approval unlocks the digital download.',
    ],
  },
];

/** Accurate statements that MUST remain allowed. */
const ALLOWED_FIXTURES: Array<[string, string]> = [
  ['print gated on approval', 'Printed books enter production only after approval; carrier timing can vary.'],
  ['nothing prints until approval', 'Physical books are not printed until you approve the digital proof.'],
  ['print ships after approval', 'Printed books ship 5–7 business days after you approve.'],
  ['approval accepts the book', 'Approving accepts the book.'],
  ['corrected gifts copy', 'Digital orders receive the full PDF with the proof email; approving accepts the book.'],
  ['corrected expectation', 'Digital proof usually ready in 2–3 business days; the full high-resolution PDF comes with it, and you approve when it is right.'],
  ['corrected thank-you', 'Digital orders get the full high-resolution PDF with that proof email; approving accepts the book.'],
  ['corrected editorial', 'Your proof arrives with the full Digital PDF — no shipping step at all.'],
  ['refund boundary', 'Digital orders are fully refundable up until you approve the proof.'],
  ['refund finality', 'Approving accepts the book, and the digital order is final from that point.'],
  ['proof-first, no file token', 'You review every page before approving.'],
  ['print submission after approval', 'After approval, we queue the job with our print partner.'],
  ['bulleted print card', 'Proof usually ready in 2–3 business days · Softcover ships 5–7 business days after approval · Digital PDF included'],
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
  for (const channel of [email.html, email.text] as const) {
    assert.equal(bannedTimingClaim(channel), null, 'delivery email makes an approval-first promise');
  }
});

test('approving mints no artifact — it records acceptance', () => {
  const src = read('src/lib/page-review.ts');
  const approve = src.slice(src.indexOf('export async function approveWholeBook'));
  assert.match(approve, /reviewStatus: 'approved'/, 'approval sets the accepted state');
  assert.ok(!/_upload\(|buildPdf\(|storyArtifactUrl:\s*[^,\s]/.test(approve.slice(0, 2000)),
    'approval must not build or attach a new artifact');
});

// ── 1b. The grammar itself, tested directly ─────────────────────────────────

test('every banned construction is caught by the predicate', () => {
  for (const [label, sentence] of BANNED_FIXTURES) {
    assert.notEqual(bannedTimingClaim(sentence), null, `MISSED "${label}": ${sentence}`);
  }
});

test('every exact blocked approval-first paraphrase and its disposable mutations are caught', () => {
  for (const fixture of EXACT_TIMING_FIXTURES) {
    assert.notEqual(bannedTimingClaim(fixture.sentence), null, `MISSED "${fixture.label}": ${fixture.sentence}`);
    for (const probe of fixture.probes) {
      assert.notEqual(
        bannedTimingClaim(probe),
        null,
        `MISSED mutation for "${fixture.label}": ${probe}`,
      );
    }
  }
});

test('every accurate construction is left alone by the predicate', () => {
  for (const [label, sentence] of ALLOWED_FIXTURES) {
    const claim = bannedTimingClaim(sentence);
    assert.equal(claim, null, `FALSE POSITIVE on "${label}" (matched ${claim}): ${sentence}`);
  }
});

test('clause splitting keeps a true compound from reading as one claim', () => {
  // The exact shape that would otherwise false-positive: a delivery clause and
  // an approval clause joined by a semicolon.
  const compound = 'Digital orders receive the full PDF with the proof email; approving accepts the book.';
  assert.deepEqual(clausesOf(compound), [
    'Digital orders receive the full PDF with the proof email',
    'approving accepts the book',
  ]);
  assert.equal(bannedTimingClaim(compound), null);
});

// ── 2. No served surface claims approval delivers the PDF ───────────────────

test('no served customer surface says the PDF arrives only after approval', () => {
  for (const file of servedSources()) {
    const claim = bannedTimingClaim(withoutComments(read(file)));
    assert.equal(claim, null, `${file} makes an approval-first promise (${claim}) the digital path does not keep`);
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
      assert.equal(bannedTimingClaim(channel), null, `${bookFormat} confirmation email makes an approval-first promise`);
    }
  }
});

test('all six customer email builders stay free of approval-first PDF claims across formats and channels', () => {
  const digitalOrder = createOrderRecord(
    { childName: 'Nia', bookFormat: 'digital', email: 'nia@example.com' },
    { id: 'ord_email_audit_digital' },
  );
  const printOrder = createOrderRecord(
    { childName: 'Leo', bookFormat: 'classic', email: 'leo@example.com' },
    { id: 'ord_email_audit_print' },
  );

  const emails = [
    ['confirmation:digital', buildOrderConfirmationEmail(digitalOrder, { supportEmail: 'support@herostorybooks.com' })],
    ['confirmation:print', buildOrderConfirmationEmail(printOrder, { supportEmail: 'support@herostorybooks.com' })],
    ['preview-ready:digital', buildPreviewReadyEmail({ ...digitalOrder, status: 'preview_ready' }, { supportEmail: 'support@herostorybooks.com' })],
    ['preview-ready:print', buildPreviewReadyEmail({ ...printOrder, status: 'preview_ready' }, { supportEmail: 'support@herostorybooks.com' })],
    ['print-in-production', buildPrintInProductionEmail({ ...printOrder, status: 'print_in_production' }, { supportEmail: 'support@herostorybooks.com' })],
    ['shipped', buildShippedEmail({ ...printOrder, status: 'shipped' }, { supportEmail: 'support@herostorybooks.com' })],
    ['digital-delivery', buildDigitalDeliveryEmail(digitalOrder, {
      pdfUrl: 'https://example.invalid/proof.pdf',
      reviewUrl: 'https://example.invalid/review',
      supportEmail: 'support@herostorybooks.com',
    })],
    ['proof-ready', buildProofReadyEmail(printOrder, {
      reviewUrl: 'https://example.invalid/review',
      proofUrl: 'https://example.invalid/proof.pdf',
      supportEmail: 'support@herostorybooks.com',
    })],
  ] as const;

  for (const [label, email] of emails) {
    for (const channel of [email.html, email.text] as const) {
      assert.equal(bannedTimingClaim(channel), null, `${label} makes an approval-first PDF claim`);
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

function resolveImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return path.join('src', specifier.slice(2));
  if (!specifier.startsWith('.')) return null;
  return path.normalize(path.join(path.dirname(fromFile), specifier));
}

function directImporters(targetFile: string): string[] {
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) all.push(full);
    }
  };
  walk('src');

  const targetStem = targetFile.replace(/\.[^.]+$/, '');
  return all.filter((file) => {
    if (file === targetFile) return false;
    const imports = [...read(file).matchAll(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((match) => match[1] ?? match[2])
      .filter(Boolean) as string[];
    return imports.some((specifier) => {
      const resolved = resolveImport(file, specifier);
      if (!resolved) return false;
      return resolved === targetFile || resolved === targetStem || resolved === `${targetStem}.ts` || resolved === `${targetStem}.tsx`;
    });
  });
}

test('files still carrying the stale claim are genuinely unserved by direct import proof', () => {
  for (const file of UNREACHABLE_WITH_STALE_CLAIM) {
    const importers = directImporters(file);
    assert.deepEqual(
      importers, [],
      `${file} is now directly imported. Its approval-first PDF copy is stale and must be ` +
        'corrected before it can be served, or removed from this exclusion list.',
    );
  }
});

test('the stale pricing module itself remains unreachable from served code', () => {
  assert.deepEqual(
    directImporters('src/lib/pricing.ts'),
    ['src/components/pricing-section.tsx'],
    'src/lib/pricing.ts must stay confined to the dead pricing section until its legacy copy is remediated',
  );
});
