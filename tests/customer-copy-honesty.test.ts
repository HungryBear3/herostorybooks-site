/**
 * Customer copy may not claim a gate the pipeline does not enforce.
 *
 * Candidate c66ed44 shipped "Every book is personally reviewed before we send
 * you the proof." That was false: `runDigitalFulfillment` and
 * `runPrintFulfillment` persist the proof and call sendDigitalDeliveryEmail /
 * sendProofReadyEmail with no `qaPassAt`, `qaStatus`, page-level `reviewedAt`,
 * or operator-release prerequisite — those fields are ops-dashboard state, not
 * gates (Rex audit 2026-08-21).
 *
 * This suite is the standing lock. It asserts two independent things:
 *
 *   1. No served customer surface or customer email claims a human review,
 *      a quality guarantee, or a fixed delivery time.
 *   2. That claim stays absent *because* the pipeline still has no QA gate — so
 *      if someone ever adds a real gate, this suite tells them the copy may
 *      finally say so, rather than silently keeping a stale prohibition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { createOrderRecord } from '../src/lib/orders.ts';
import {
  buildOrderConfirmationEmail,
  buildPreviewReadyEmail,
  buildPrintInProductionEmail,
} from '../src/lib/order-email.ts';
import {
  PROOF_DELAY_SUPPORT_NOTE,
  PROOF_REVIEW_ASSURANCE,
  PROOF_TURNAROUND_WINDOW,
  PROOF_VOLUME_NOTE,
} from '../src/lib/proof-turnaround.ts';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Customer copy is what a customer can READ, so engineering comments must not
 * be scanned: this very file's neighbours explain the prohibition in prose, and
 * a naive source scan would flag the explanation as the violation. Strips block
 * comments and line comments, leaving `://` alone so URLs survive.
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every served, non-admin source file — customer-reachable copy lives here. */
function servedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'admin' || entry === 'node_modules') continue;
        walk(full);
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        out.push(full);
      }
    }
  };
  for (const root of ['src/app', 'src/components', 'src/lib']) walk(root);
  return out;
}

/**
 * Claims of a human checking the work before the customer sees it. Written to
 * catch the paraphrase, not just the exact sentence that shipped.
 */
const HUMAN_REVIEW_CLAIMS: Array<[string, RegExp]> = [
  ['every book personally/manually reviewed', /\bevery\s+(book|order|page|proof)\b[^.]{0,50}\b(personally|manually|hand)[- ]?(review|check|inspect)/i],
  ['personally reviewed before the proof', /\b(personally|manually)\s+(review|checked|inspected)[^.]{0,60}\bbefore\b[^.]{0,40}\bproof\b/i],
  ['a person checks every page', /\b(a\s+)?(person|human|editor|artist|our team)\b[^.]{0,40}\b(check|review|inspect)[a-z]*\b[^.]{0,30}\bevery\s+(page|book|proof)\b/i],
  ['QA approval before release', /\b(QA|quality)\b[^.]{0,30}\b(approv|sign[- ]?off|pass)[a-z]*\b[^.]{0,40}\bbefore\b[^.]{0,40}\b(proof|release|send|email)/i],
];

/** Outcome/quality guarantees and fixed-time promises. */
const GUARANTEE_CLAIMS: Array<[string, RegExp]> = [
  ['defect-free / flawless output', /\b(defect[- ]free|flawless|error[- ]free)\b|\bperfect\s+(book|proof|copy|print|result)s?\b/i],
  ['guaranteed quality or outcome', /\bguarantee[a-z]*\b[^.]{0,25}\b(quality|outcome|result|satisfaction|proof|turnaround)\b/i],
  ['instant or same-day proof', /\b(instant|immediate|same[- ]day|overnight)\s+(digital\s+)?(proof|preview)\b/i],
  // The negative lookbehind matters: existing checkout copy correctly DISCLAIMS
  // a likeness guarantee ("proof-team references only, not guaranteed …"), and
  // a disclaimer is the opposite of the promise being banned.
  ['fixed-time proof promise', /\b(proof|preview)\b[^.]{0,40}(?<!\b(?:not|never|no|isn't|aren't)\s)\b(guaranteed|always|within exactly)\b/i],
];

// ── 1. The prohibited claim is absent everywhere a customer can see it ───────

test('no served customer surface claims a human reviews every book before the proof', () => {
  for (const file of servedSources()) {
    const src = withoutComments(read(file));
    for (const [claim, pattern] of HUMAN_REVIEW_CLAIMS) {
      const hit = src.match(pattern);
      assert.equal(hit?.[0] ?? null, null, `${file} makes a "${claim}" promise the pipeline does not enforce`);
    }
  }
});

test('no served customer surface promises defect-free work, a guarantee, or a fixed proof time', () => {
  for (const file of servedSources()) {
    const src = withoutComments(read(file));
    for (const [claim, pattern] of GUARANTEE_CLAIMS) {
      const hit = src.match(pattern);
      assert.equal(hit?.[0] ?? null, null, `${file} makes a "${claim}" promise`);
    }
  }
});

test('every customer email body is free of the prohibited claims', () => {
  for (const bookFormat of ['digital', 'classic', 'premium']) {
    const order = createOrderRecord(
      { childName: 'Ada', bookFormat, email: 'ada@example.com' },
      { id: `ord_honesty_${bookFormat}` },
    );
    const bodies = [
      buildOrderConfirmationEmail(order, { supportEmail: 'support@herostorybooks.com' }),
      buildPreviewReadyEmail(order, { supportEmail: 'support@herostorybooks.com' }),
      buildPrintInProductionEmail(order, { supportEmail: 'support@herostorybooks.com' }),
    ];
    for (const email of bodies) {
      for (const channel of [email.html, email.text] as const) {
        for (const [claim, pattern] of [...HUMAN_REVIEW_CLAIMS, ...GUARANTEE_CLAIMS]) {
          const hit = channel.match(pattern);
          assert.equal(hit?.[0] ?? null, null, `${bookFormat} email makes a "${claim}" promise`);
        }
      }
    }
  }
});

// ── 2. The replacement says only what the pipeline actually does ─────────────

test('the proof assurance describes the automated pipeline, not a human gate', () => {
  assert.match(PROOF_REVIEW_ASSURANCE, /write the story/i, 'must name the generation step');
  assert.match(PROOF_REVIEW_ASSURANCE, /illustrate every page/i, 'must name the illustration step');
  assert.match(PROOF_REVIEW_ASSURANCE, /build your proof/i, 'must name the proof build');
  for (const [claim, pattern] of [...HUMAN_REVIEW_CLAIMS, ...GUARANTEE_CLAIMS]) {
    assert.equal(PROOF_REVIEW_ASSURANCE.match(pattern)?.[0] ?? null, null, `assurance must not imply "${claim}"`);
  }
  // Still no second number, and no invented queue position.
  assert.ok(!/\d/.test(PROOF_REVIEW_ASSURANCE), 'assurance must carry no numeric claim');
});

test('the pipeline it describes is exactly the one fulfillment runs', () => {
  // Each clause of the assurance maps to a real fulfillment stage, so the copy
  // cannot drift away from the code that justifies it.
  const fulfillment = read('src/lib/fulfillment.ts');
  for (const stage of ["'generating_story'", "'generating_images'", "'building_pdf'"]) {
    assert.ok(fulfillment.includes(stage), `fulfillment must still run ${stage}`);
  }
});

test('no QA gate exists yet — so the copy may not claim one', () => {
  // The guard that makes this suite self-correcting. If someone adds a real
  // authoritative QA prerequisite to the release path, this test fails and the
  // author is told to revisit the copy prohibition above rather than leaving a
  // now-stale rule in place.
  const releasePath = read('src/lib/fulfillment.ts');
  for (const gate of ['qaPassAt', 'qaStatus']) {
    assert.ok(
      !releasePath.includes(gate),
      `src/lib/fulfillment.ts now references ${gate}. If proof release is genuinely gated on QA, ` +
        'update PROOF_REVIEW_ASSURANCE and the prohibitions in this suite deliberately.',
    );
  }
});

// ── 3. The rest of the honest-expectation copy is unchanged ─────────────────

test('the volume caveat, support path, and approved window are untouched', () => {
  assert.equal(PROOF_TURNAROUND_WINDOW, '2–3 business days');
  assert.match(PROOF_VOLUME_NOTE, /volume is high/i);
  assert.match(PROOF_VOLUME_NOTE, /longer than usual/i);
  assert.match(PROOF_DELAY_SUPPORT_NOTE, /support@herostorybooks\.com/);
});

test('the assurance is still single-sourced onto every surface that carries it', () => {
  for (const [label, file] of [
    ['homepage/FAQ', 'src/components/editorial-site.tsx'],
    ['checkout', 'src/app/checkout/checkout-form.tsx'],
    ['thank-you', 'src/app/thank-you/page.tsx'],
    ['confirmation email', 'src/lib/order-email.ts'],
  ] as Array<[string, string]>) {
    const src = read(file);
    assert.match(src, /PROOF_REVIEW_ASSURANCE/, `${label} must render the shared constant`);
    assert.match(src, /proof-turnaround/, `${label} must import it from the canonical module`);
  }
});

test('confirmation email carries the replacement wording in HTML and text alike', () => {
  for (const bookFormat of ['digital', 'classic', 'premium']) {
    const order = createOrderRecord(
      { childName: 'Nia', bookFormat, email: 'nia@example.com' },
      { id: `ord_honesty_parity_${bookFormat}` },
    );
    const email = buildOrderConfirmationEmail(order, { supportEmail: 'support@herostorybooks.com' });
    assert.ok(email.html.includes(PROOF_REVIEW_ASSURANCE), `${bookFormat}: HTML missing the assurance`);
    assert.ok(email.text.includes(PROOF_REVIEW_ASSURANCE), `${bookFormat}: text missing the assurance`);
  }
});
