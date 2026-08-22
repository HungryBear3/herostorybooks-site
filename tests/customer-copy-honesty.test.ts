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
  buildDigitalDeliveryEmail,
  buildOrderConfirmationEmail,
  buildPreviewReadyEmail,
  buildPrintInProductionEmail,
  buildProofReadyEmail,
  buildShippedEmail,
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

/**
 * The private friends-and-family custom-memory beta is a DIFFERENT product with
 * a real enforced gate: src/app/api/order/route.ts refuses checkout with
 * `custom_story_manual_review_required` unless the brief's shape is
 * concierge-allowed. Its human-review copy is therefore accurate, not a blanket
 * every-order promise. A test below asserts that gate still exists, so if it is
 * ever removed these files stop being exempt.
 */
const CONCIERGE_BETA_WITH_ENFORCED_GATE = new Set([
  'src/app/create/your-memory/page.tsx',
  'src/app/create/your-memory/paid-memory-beta-form.tsx',
]);
const NON_CUSTOMER_SOURCES = new Set([
  'src/lib/admin-actions.ts',
  'src/lib/admin-auth.ts',
  'src/lib/family-review/admin-auth.ts',
  'src/lib/order-diagnostics.ts',
  'src/lib/order-email.ts',
]);

/** Every served, non-admin source file — customer-reachable copy lives here. */
function servedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'admin' || entry === 'node_modules') continue;
        walk(full);
      } else if (
        (full.endsWith('.ts') || full.endsWith('.tsx'))
        && !CONCIERGE_BETA_WITH_ENFORCED_GATE.has(full)
        && !NON_CUSTOMER_SOURCES.has(full)
      ) {
        out.push(full);
      }
    }
  };
  for (const root of ['src/app', 'src/components', 'src/lib']) walk(root);
  return out;
}

/**
 * Claims that a human checks the work before the customer sees it.
 *
 * Rex's audit of d11cc20 blocked because the first version of this list was
 * induced from the one sentence that had shipped, so it only recognised VERB
 * constructions ("every book is personally reviewed before we send the proof")
 * and missed the two live NOUN-PHRASE claims: the trust-strip bullet
 * "Human story and art review" and "Every order includes … human story and art
 * review …". Both are absolute every-order promises with no verb at all.
 *
 * The list is now organised by claim shape, and the predicate is exported and
 * driven by fixtures below so the grammar is tested directly.
 */
const HUMAN = String.raw`(?:human|person|people|staff|team|expert|editor(?:ial)?|artist|manual|our\s+team|a\s+real\s+person)`;
const REVIEW = String.raw`(?:review|reviewed|reviews|check|checked|checks|inspect|inspected|inspection|proofread|vet|vets|vetted|QA|quality\s+check|quality\s+pass|sign[- ]?off|signs?\s+off|signed\s+off)`;
const PRODUCT = String.raw`(?:story|art|artwork|page|pages|book|books|proof|proofs|illustration|illustrations|copy|editorial|quality|order|delivery|fulfillment)`;

const HUMAN_REVIEW_CLAIMS: Array<[string, RegExp]> = [
  ['every book personally/manually reviewed', /\bevery\s+(book|order|page|proof)\b[^.;!?]{0,50}\b(personally|manually|hand)[- ]?(review|check|inspect)/i],
  ['personally reviewed before the proof', /\b(personally|manually)\s+(review|checked|inspected)[^.;!?]{0,60}\bbefore\b[^.;!?]{0,40}\bproof\b/i],
  ['a person checks every page', new RegExp(String.raw`\b(?:a\s+)?${HUMAN}\b[^.;!?]{0,40}\b${REVIEW}[a-z]*\b[^.;!?]{0,30}\bevery\s+(page|book|proof|order)\b`, 'i')],
  ['QA approval before release', /\b(QA|quality)\b[^.;!?]{0,30}\b(approv|sign[- ]?off|pass)[a-z]*\b[^.;!?]{0,40}\bbefore\b[^.;!?]{0,40}\b(proof|release|send|email)/i],
  // HSB-QA-1a: the bare noun phrase, no verb, no "every" — e.g. the trust-strip
  // bullet "Human story and art review". Only words naming the PRODUCT (or the
  // conjunctions joining them) may sit between the two halves, so an unrelated
  // narrow statement like "Saved with this person for operator review" — which
  // is about one optional supporting-character photo, not an every-order gate —
  // does not match.
  ['human review as a bare feature claim', new RegExp(String.raw`\b${HUMAN}\b(?:\s+(?:${PRODUCT}|and|or|the|your))*\s+${REVIEW}\b`, 'i')],
  // HSB-QA-1b: "Every order includes … human story and art review".
  ['every order includes human review', new RegExp(String.raw`\bevery\s+(?:order|book|proof|page)\b[^.;!?]{0,80}\b${HUMAN}\b[^.;!?]{0,40}\b${REVIEW}\b`, 'i')],
  ['human-reviewed compound', /\b(human|hand)[- ]reviewed\b/i],
  ['reviewed by our team', new RegExp(String.raw`\b${REVIEW}\b\s+by\s+(?:a\s+|an\s+|our\s+)?${HUMAN}\b`, 'i')],
  ['staff review before proof or delivery', new RegExp(String.raw`\b${HUMAN}\b[^.;!?]{0,40}\b${REVIEW}\b[^.;!?]{0,70}(?:\bbefore\b|\bprior\s+to\b)[^.;!?]{0,40}\b(?:proof|delivery|fulfillment|sent|send|sending|emailed|released|release|printing|print\s+production)\b`, 'i')],
  ['human reviews each item before delivery', new RegExp(String.raw`\b${HUMAN}\b[^.;!?]{0,35}\b${REVIEW}\b[^.;!?]{0,35}\b(?:each|every)\s+(?:order|book|proof|page)\b[^.;!?]{0,45}(?:\bbefore\b|\bprior\s+to\b)[^.;!?]{0,30}\b(?:delivery|fulfillment|send|sending|emailed|release|printing|print\s+production|print\s+release)\b`, 'i')],
  ['each item reviewed by human before delivery', new RegExp(String.raw`\b(?:each|every)\s+(?:order|book|proof|page)\b[^.;!?]{0,35}\b${REVIEW}\b[^.;!?]{0,20}\bby\s+(?:a\s+|an\s+|our\s+)?${HUMAN}\b[^.;!?]{0,45}(?:\bbefore\b|\bprior\s+to\b)[^.;!?]{0,30}\b(?:delivery|fulfillment|send|sending|emailed|release)\b`, 'i')],
  ['every item gets expert or editorial review', new RegExp(String.raw`\bevery\s+(?:order|book|proof)\b[^.;!?]{0,30}\b(?:gets|includes|receives)\b[^.;!?]{0,30}\b${HUMAN}\b[^.;!?]{0,20}\b${REVIEW}\b`, 'i')],
  ['team quality check for every proof', new RegExp(String.raw`\bevery\s+proof\b[^.;!?]{0,40}\b(?:gets|includes|receives)\b[^.;!?]{0,30}\b(?:team|staff|human)\b[^.;!?]{0,20}\b(?:quality\s+check|quality\s+pass|check)\b`, 'i')],
];

/**
 * A human step that is explicitly THRESHOLD-SCOPED is escalation, not an
 * every-order promise, and it is real: page-review.ts crosses
 * REGEN_MANUAL_REVIEW_THRESHOLD and fires sendRegenManualReviewAlert. The live
 * sentence it protects is "after 5, the page is flagged for a human quality
 * check". A test below asserts that threshold behavior still exists, so the
 * allowance stays earned rather than assumed.
 */
const THRESHOLD_SCOPED = /\bafter\s+(?:\d+|three|four|five)\b|\bif\b|\bmay\s+step\s+in\b|\bexceeds?\b/i;
// This is deliberately exact. The authenticated operator boundary supports the
// production-release sentence currently served; it does not support generic
// promises that every book, page, order, or piece of art receives human QA.
const PRINT_RELEASE_SCOPED = /^our\s+team\s+will\s+complete\s+the\s+final\s+production\s+check\s+before\s+print\s+release$/i;

function clausesOf(text: string): string[] {
  return text.split(/[.;!?\n·]+/g).map((c) => c.trim()).filter(Boolean);
}

/** Label of the first unsupported human-review claim found, or null. */
export function bannedHumanReviewClaim(text: string): string | null {
  for (const clause of clausesOf(text)) {
    if (THRESHOLD_SCOPED.test(clause) || PRINT_RELEASE_SCOPED.test(clause)) continue;
    for (const [label, pattern] of HUMAN_REVIEW_CLAIMS) {
      if (pattern.test(clause)) return label;
    }
  }
  return null;
}

/** Constructions that MUST be caught, including both strings Rex found. */
const BANNED_HUMAN_FIXTURES: Array<[string, string]> = [
  ['HSB-QA-1a exact', 'Human story and art review'],
  ['HSB-QA-1b exact', 'Every order includes a full digital proof before anything prints, human story and art review, and no blind hardcover order.'],
  ['original shipped claim', 'Every book is personally reviewed before we send you the proof.'],
  ['bare human review', 'Human review'],
  ['hand-reviewed writing', 'Your child becomes the hero through 24 illustrated story pages, hand-reviewed writing, and keepsake matter'],
  ['hand-reviewed before print', 'Uploaded photo storybook illustration hand-reviewed before print'],
  ['reviewed by people', 'the order is still reviewed by people before fulfillment'],
  ['a person checks every page', 'A person checks every page before it goes out'],
  ['human proof review', 'human proof review'],
  ['each book expert review', 'Each book is reviewed by an expert before delivery.'],
  ['team signoff every proof', 'Our team signs off on every proof before sending.'],
  ['team QA every proof', 'Every proof receives team QA before it is emailed.'],
  ['staff vets each order', 'Our staff vets each order prior to delivery.'],
  ['editorial signoff every proof', 'Every proof receives editorial sign-off before release.'],
  ['generic team review before printing', 'Our team will review every book before printing.'],
  ['generic human page inspection', 'A human will inspect every page before print production.'],
  ['generic staff order check', 'Our staff will check each order before printing.'],
  ['generic story-art review', 'Our team will review all story art before print release.'],
  ['production check before printing', 'Our team will complete the final production check before printing.'],
  ['production check before print production', 'Our team will complete the final production check before print production.'],
];

const EXACT_HUMAN_FIXTURES: Array<{ label: string; sentence: string; probes: string[] }> = [
  {
    label: 'staff checks every order before the proof is sent',
    sentence: 'Staff checks every order before the proof is sent.',
    probes: [
      'The team checks every order before the proof is sent.',
      'A human checks every order before the proof email goes out.',
      'Staff inspects every order before delivery.',
    ],
  },
  {
    label: 'every book gets an expert review before delivery',
    sentence: 'Every book gets an expert review before delivery.',
    probes: [
      'Every book gets a human review before delivery.',
      'Every book receives an artist review before fulfillment.',
      'Every order gets an expert check before delivery.',
    ],
  },
  {
    label: 'every order includes an editorial review before fulfillment',
    sentence: 'Every order includes an editorial review before fulfillment.',
    probes: [
      'Every order includes a manual review before fulfillment.',
      'Every order includes a human editorial review before delivery.',
      'Every order includes an editor check before fulfillment.',
    ],
  },
  {
    label: 'every proof gets a team quality check',
    sentence: 'Every proof gets a team quality check.',
    probes: [
      'Every proof gets a staff quality check.',
      'Every proof receives a human quality pass.',
      'Every proof gets an expert check.',
    ],
  },
];

/** Accurate constructions that MUST remain allowed. */
const ALLOWED_HUMAN_FIXTURES: Array<[string, string]> = [
  ['fifth-regen escalation', 'After 3 tries on one page, we may step in to help; after 5, the page is flagged for a human quality check so we do not burn your time.'],
  ['customer reviews the pages', 'You review every page before approving.'],
  ['proof before print', 'Full digital proof before any printing'],
  ['revisions included', 'Revisions included before approval'],
  ['operator photo note', 'Saved with this person for operator review'],
  ['customer re-reads details', 'Extra details are optional and can be reviewed by going back to Hero details'],
  ['automated pipeline', 'We write the story, illustrate every page, and build your proof before it reaches you.'],
  ['operator print-release gate', 'Our team will complete the final production check before print release.'],
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
    const claim = bannedHumanReviewClaim(withoutComments(read(file)));
    assert.equal(claim, null, `${file} makes a "${claim}" promise the pipeline does not enforce`);
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
        assert.equal(bannedHumanReviewClaim(channel), null, `${bookFormat} email makes a human-review promise`);
        for (const [claim, pattern] of GUARANTEE_CLAIMS) {
          assert.equal(channel.match(pattern)?.[0] ?? null, null, `${bookFormat} email makes a "${claim}" promise`);
        }
      }
    }
  }
});

test('all six customer email builders stay free of human-review claims across formats and channels', () => {
  const digitalOrder = createOrderRecord(
    { childName: 'Ada', bookFormat: 'digital', email: 'ada@example.com' },
    { id: 'ord_honesty_builder_digital' },
  );
  const printOrder = createOrderRecord(
    { childName: 'Leo', bookFormat: 'classic', email: 'leo@example.com' },
    { id: 'ord_honesty_builder_print' },
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
      assert.equal(bannedHumanReviewClaim(channel), null, `${label} makes a human-review promise`);
    }
  }
});

// ── 2. The replacement says only what the pipeline actually does ─────────────

test('every banned human-review construction is caught', () => {
  for (const [label, sentence] of BANNED_HUMAN_FIXTURES) {
    assert.notEqual(bannedHumanReviewClaim(sentence), null, `MISSED "${label}": ${sentence}`);
  }
});

test('every exact blocked human-review paraphrase and its disposable mutations are caught', () => {
  for (const fixture of EXACT_HUMAN_FIXTURES) {
    assert.notEqual(bannedHumanReviewClaim(fixture.sentence), null, `MISSED "${fixture.label}": ${fixture.sentence}`);
    for (const probe of fixture.probes) {
      assert.notEqual(
        bannedHumanReviewClaim(probe),
        null,
        `MISSED mutation for "${fixture.label}": ${probe}`,
      );
    }
  }
});

test('every accurate construction is left alone', () => {
  for (const [label, sentence] of ALLOWED_HUMAN_FIXTURES) {
    const claim = bannedHumanReviewClaim(sentence);
    assert.equal(claim, null, `FALSE POSITIVE on "${label}" (matched ${claim}): ${sentence}`);
  }
});

test('the threshold allowance is earned — the regen escalation really exists', () => {
  const src = read('src/lib/page-review.ts');
  assert.match(src, /REGEN_MANUAL_REVIEW_THRESHOLD/, 'threshold constant must exist');
  assert.match(src, /sendRegenManualReviewAlert|sendManualReviewAlert/, 'the alert must actually be sent');
});

test('the concierge-beta exemption still has its enforced gate', () => {
  const route = read('src/app/api/order/route.ts');
  assert.match(route, /custom_story_manual_review_required/,
    'the concierge manual-review refusal must still exist, or its human-review copy stops being accurate');
  assert.match(route, /conciergeAllowed/, 'checkout must still gate on concierge allowance');
});

test('the print-release exemption still has its authenticated operator gate', () => {
  const actions = read('src/lib/admin-actions.ts');
  const route = read('src/app/api/admin/orders/[orderId]/manual-approve/route.ts');
  assert.match(actions, /manuallyApproveProof/, 'operator approval action must still exist');
  assert.match(actions, /approvePrintProof/, 'operator action must still cross the print-release gate');
  assert.match(route, /isAdminAuthedFromRequest/, 'print-release route must remain admin-authenticated');
});

test('the proof assurance describes the automated pipeline, not a human gate', () => {
  assert.match(PROOF_REVIEW_ASSURANCE, /write the story/i, 'must name the generation step');
  assert.match(PROOF_REVIEW_ASSURANCE, /illustrate every page/i, 'must name the illustration step');
  assert.match(PROOF_REVIEW_ASSURANCE, /build your proof/i, 'must name the proof build');
  assert.equal(bannedHumanReviewClaim(PROOF_REVIEW_ASSURANCE), null, 'assurance must not imply human review');
  for (const [claim, pattern] of GUARANTEE_CLAIMS) {
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
