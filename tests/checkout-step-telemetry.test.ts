// Privacy-safe checkout step telemetry: checkout_step_view / _complete /
// _blocked. These events exist to make the four-step checkout measurable
// before any mobile redesign, so they must be (a) deduplicated per step per
// mount, (b) emitted only on the real validation outcome, and (c) free of any
// buyer- or child-authored content. The adversarial test below plants a
// distinctive fake token in every free-form field and proves none of it
// reaches the event buffer, gtag, or Vercel Analytics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_STEP_BLOCKED_REASONS,
  CHECKOUT_TELEMETRY_STEP_IDS,
  CHECKOUT_TELEMETRY_TOTAL_STEPS,
  checkoutStepBlockedReason,
  checkoutStepEventProps,
  checkoutSubmitBlockedReason,
  createCheckoutStepViewDeduper,
} from '../src/lib/checkout-step-telemetry.ts';
import {
  getCheckoutProgress,
  type CheckoutProgressFormShape,
  type SupportingCharacterRecord,
} from '../src/lib/checkout-progressive.ts';

const CHECKOUT_FORM_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const ANALYTICS_SRC = readFileSync('src/lib/analytics.ts', 'utf8');

function makePerson(overrides: Partial<SupportingCharacterRecord> = {}): SupportingCharacterRecord {
  return {
    id: 'person-1',
    role: 'dad',
    name: 'Dad',
    relationshipLabel: 'Dad',
    pronouns: '',
    notes: 'tall with a beard',
    isGiftRecipient: false,
    appearsInStory: true,
    photoFile: null,
    photoDataUrl: null,
    mustInclude: [],
    mustIncludeOther: '',
    focusPersonLabel: '',
    cropHint: '',
    ...overrides,
  };
}

function makeForm(overrides: Partial<CheckoutProgressFormShape> = {}): CheckoutProgressFormShape {
  return {
    theme: 'brave-explorer',
    childName: 'Emma',
    characterNotes: 'warm brown skin and short curly dark hair',
    photoFile: null,
    familyCharacters: [],
    bookFormat: 'digital',
    email: 'parent@example.com',
    voiceFile: null,
    voiceConsent: false,
    customStoryMemory: '',
    directMediaConsent: false,
    ...overrides,
  };
}

function stepOf(form: CheckoutProgressFormShape, id: string) {
  const step = getCheckoutProgress(form).steps.find((s) => s.id === id);
  assert.ok(step, `missing step ${id}`);
  return step;
}

// ── Step identity ───────────────────────────────────────────────────────────

test('telemetry step ordinals follow the progressive checkout step order exactly', () => {
  const machineOrder = getCheckoutProgress(makeForm()).steps.map((step) => step.id);
  assert.deepEqual([...CHECKOUT_TELEMETRY_STEP_IDS], machineOrder);
  assert.equal(CHECKOUT_TELEMETRY_TOTAL_STEPS, 4);
  assert.equal(CHECKOUT_TELEMETRY_TOTAL_STEPS, machineOrder.length);
});

test('checkoutStepEventProps emits only step_id, step_number, total_steps and selected_format', () => {
  assert.deepEqual(checkoutStepEventProps('hero-appearance', 'classic'), {
    step_id: 'hero-appearance',
    step_number: 2,
    total_steps: 4,
    selected_format: 'classic',
  });
  assert.deepEqual(checkoutStepEventProps('review', 'premium'), {
    step_id: 'review',
    step_number: 4,
    total_steps: 4,
    selected_format: 'premium',
  });
});

test('selected_format is a whitelisted identifier, never a free-form value', () => {
  assert.equal(checkoutStepEventProps('hero-details', 'digital').selected_format, 'digital');
  assert.equal(checkoutStepEventProps('hero-details', '').selected_format, null);
  assert.equal(checkoutStepEventProps('hero-details', null).selected_format, null);
  assert.equal(checkoutStepEventProps('hero-details', 'ZQX-FORMAT-INJECTED').selected_format, null);
  assert.equal(checkoutStepEventProps('hero-details', 'Digital').selected_format, null);
});

// ── View deduplication ──────────────────────────────────────────────────────

test('view deduper emits once per step per page flow, including on revisits', () => {
  const deduper = createCheckoutStepViewDeduper();
  assert.equal(deduper.shouldEmit('hero-details'), true);
  assert.equal(deduper.shouldEmit('hero-details'), false, 'a re-render of the same step must not re-emit');
  assert.equal(deduper.shouldEmit('hero-appearance'), true);
  assert.equal(deduper.shouldEmit('hero-details'), false, 'navigating back is the same flow, not a new view');
  assert.equal(deduper.shouldEmit('hero-appearance'), false);
  assert.equal(deduper.shouldEmit('review'), true);
});

test('a fresh deduper (new mount) starts over', () => {
  const first = createCheckoutStepViewDeduper();
  first.shouldEmit('people');
  const second = createCheckoutStepViewDeduper();
  assert.equal(second.shouldEmit('people'), true);
});

// ── Blocked reason codes ────────────────────────────────────────────────────

test('blocked reason is a bounded code from the source-maintained enum', () => {
  const reasons = new Set<string>(CHECKOUT_STEP_BLOCKED_REASONS);
  assert.ok(reasons.has('other'), 'the enum keeps a fallback code');
  for (const reason of CHECKOUT_STEP_BLOCKED_REASONS) {
    assert.match(reason, /^[a-z][a-z0-9_]{2,40}$/, `reason ${reason} must be a short snake_case token`);
  }
});

test('a step with nothing missing has no blocked reason', () => {
  assert.equal(checkoutStepBlockedReason(stepOf(makeForm(), 'hero-details')), null);
  assert.equal(checkoutStepBlockedReason(stepOf(makeForm(), 'people')), null);
  assert.equal(checkoutStepBlockedReason(stepOf(makeForm(), 'review')), null);
});

test('hero-details blocked reasons map the first missing field to a code', () => {
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ theme: '', childName: '' }), 'hero-details')),
    'story_direction_required',
  );
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ childName: '   ' }), 'hero-details')),
    'hero_name_required',
  );
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ theme: 'custom-voice-story' }), 'hero-details')),
    'custom_story_source_required',
  );
  const invalidAttachment = new File(['x'], 'memory.exe', { type: 'application/x-msdownload' });
  assert.equal(
    checkoutStepBlockedReason(
      stepOf(makeForm({ theme: 'custom-voice-story', customStoryMemory: 'a memory', voiceFile: invalidAttachment }), 'hero-details'),
    ),
    'story_attachment_unsupported',
  );
  const audio = new File(['x'], 'memory.mp3', { type: 'audio/mpeg' });
  assert.equal(
    checkoutStepBlockedReason(
      stepOf(makeForm({ theme: 'custom-voice-story', voiceFile: audio, voiceConsent: false }), 'hero-details'),
    ),
    'story_source_consent_required',
  );
  const doc = new File(['x'], 'memory.pdf', { type: 'application/pdf' });
  assert.equal(
    checkoutStepBlockedReason(
      stepOf(makeForm({ theme: 'custom-voice-story', voiceFile: doc, voiceConsent: false }), 'hero-details'),
    ),
    'story_source_consent_required',
  );
});

test('hero-appearance, people and review blocked reasons map to codes', () => {
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ characterNotes: '' }), 'hero-appearance')),
    'hero_appearance_required',
  );
  assert.equal(
    checkoutStepBlockedReason(
      stepOf(makeForm({ activeSupportingCharacterDraft: makePerson({ name: '' }) }), 'people'),
    ),
    'person_draft_open',
  );
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ familyCharacters: [makePerson({ notes: '' })] }), 'people')),
    'family_member_incomplete',
  );
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ bookFormat: '', email: '' }), 'review')),
    'book_format_required',
  );
  assert.equal(
    checkoutStepBlockedReason(stepOf(makeForm({ email: 'not-an-email' }), 'review')),
    'email_required',
  );
});

test('an unrecognised missing-field label degrades to the fallback code, never the label itself', () => {
  const reason = checkoutStepBlockedReason({
    id: 'review',
    status: 'current',
    missingFields: ['ZQX-UNKNOWN-LABEL'],
    firstInvalidField: null,
  });
  assert.equal(reason, 'other');
});

test('every label the step machine can produce maps to a specific code (not the fallback)', () => {
  const invalidAttachment = new File(['x'], 'memory.exe', { type: 'application/x-msdownload' });
  const audio = new File(['x'], 'memory.mp3', { type: 'audio/mpeg' });
  const forms = [
    makeForm({ theme: '', childName: '', characterNotes: '', bookFormat: '', email: '' }),
    makeForm({ theme: 'custom-voice-story' }),
    makeForm({ theme: 'custom-voice-story', customStoryMemory: 'm', voiceFile: invalidAttachment }),
    makeForm({ theme: 'custom-voice-story', voiceFile: audio }),
    makeForm({ activeSupportingCharacterDraft: makePerson({ name: '' }) }),
    makeForm({ familyCharacters: [makePerson({ notes: '' })] }),
  ];
  const seenLabels = new Set<string>();
  for (const form of forms) {
    for (const step of getCheckoutProgress(form).steps) {
      for (const label of step.missingFields) {
        seenLabels.add(label);
        const reason = checkoutStepBlockedReason({ ...step, missingFields: [label] });
        assert.notEqual(reason, null, `label "${label}" should block`);
        assert.notEqual(reason, 'other', `label "${label}" has no dedicated reason code`);
        assert.ok(
          (CHECKOUT_STEP_BLOCKED_REASONS as readonly string[]).includes(reason as string),
          `reason ${reason} is not in the enum`,
        );
      }
    }
  }
  assert.ok(seenLabels.size >= 10, `expected to exercise the machine's labels, saw ${seenLabels.size}`);
});

test('submit blocked reason distinguishes wrong step, step validation and media consent', () => {
  const blockedReview = getCheckoutProgress(makeForm({ email: '' })).currentStep;
  assert.equal(
    checkoutSubmitBlockedReason({ currentStepId: 'hero-details', blockingStep: blockedReview, mediaConsentMissing: false }),
    'not_on_review_step',
  );
  assert.equal(
    checkoutSubmitBlockedReason({ currentStepId: 'review', blockingStep: blockedReview, mediaConsentMissing: false }),
    'email_required',
  );
  const readyReview = getCheckoutProgress(makeForm()).currentStep;
  assert.equal(
    checkoutSubmitBlockedReason({ currentStepId: 'review', blockingStep: readyReview, mediaConsentMissing: true }),
    'media_consent_required',
  );
  assert.equal(
    checkoutSubmitBlockedReason({ currentStepId: 'review', blockingStep: readyReview, mediaConsentMissing: false }),
    'other',
  );
});

// ── Analytics layer wiring ──────────────────────────────────────────────────

test('analytics layer declares the three step events alongside the existing funnel events', () => {
  for (const name of ['checkout_step_view', 'checkout_step_complete', 'checkout_step_blocked']) {
    assert.match(ANALYTICS_SRC, new RegExp(`\\| '${name}'`), `${name} missing from HsbEventName`);
  }
});

/** Extract the argument text of every `track("<name>", …)` call in the form source. */
function trackCallArgs(source: string, eventName: string): string[] {
  const results: string[] = [];
  const needle = `track("${eventName}"`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    let depth = 0;
    let i = start + 'track'.length;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    results.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return results;
}

test('checkout form emits each step event through the shared helper and nothing else', () => {
  assert.match(CHECKOUT_FORM_SRC, /from "@\/lib\/checkout-step-telemetry"/);
  const view = trackCallArgs(CHECKOUT_FORM_SRC, 'checkout_step_view');
  const complete = trackCallArgs(CHECKOUT_FORM_SRC, 'checkout_step_complete');
  const blocked = trackCallArgs(CHECKOUT_FORM_SRC, 'checkout_step_blocked');
  assert.equal(view.length, 1, 'exactly one view emitter (the active-step effect)');
  assert.equal(complete.length, 2, 'one completion emitter for Continue, one for the review submit');
  assert.equal(blocked.length, 2, 'one blocked emitter for Continue, one for the review submit');
  const forbidden = [
    /missingFields/, /stepError/, /summary/, /firstInvalidField/, /paymentBlockers/,
    /form\.childName/, /form\.email/, /form\.characterNotes/, /form\.customStoryMemory/,
    /form\.giftMessage/, /form\.recipientName/, /form\.familyCharacters/, /photoDataUrl/, /photoFile/,
  ];
  for (const call of [...view, ...complete, ...blocked]) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(call, pattern, `step event call must not reference ${pattern}: ${call}`);
    }
  }
  for (const call of blocked) {
    assert.match(call, /reason/, `blocked call must carry a reason code: ${call}`);
  }
});

test('view emitter is deduplicated by the shared deduper before it reaches track()', () => {
  assert.match(CHECKOUT_FORM_SRC, /createCheckoutStepViewDeduper\(\)/);
  assert.match(CHECKOUT_FORM_SRC, /\.shouldEmit\(currentStepId\)/);
});

test('existing funnel events are untouched by the step telemetry', () => {
  const count = (name: string) => trackCallArgs(CHECKOUT_FORM_SRC, name).length;
  assert.equal(count('begin_checkout'), 1);
  assert.equal(count('story_selected'), 2);
  assert.equal(count('format_selected'), 1);
  assert.equal(count('order_submit_attempt'), 1);
  assert.equal(count('purchase_intent'), 1);
});

test('review-step completion is emitted only after the submit lock is acquired and before order_submit_attempt', () => {
  const lock = CHECKOUT_FORM_SRC.indexOf('submitLockRef.current?.acquire()');
  const reviewComplete = CHECKOUT_FORM_SRC.lastIndexOf('track("checkout_step_complete"');
  const attempt = CHECKOUT_FORM_SRC.indexOf('track("order_submit_attempt"');
  assert.ok(lock > 0 && reviewComplete > lock, 'review completion must follow the lock acquisition');
  assert.ok(reviewComplete < attempt, 'review completion must precede order_submit_attempt');
});

// ── Adversarial PII exclusion ───────────────────────────────────────────────

const PII = {
  childName: 'ZQX-CHILD-NAME-7731',
  email: 'zqx.parent.7731@example.invalid',
  characterNotes: 'ZQX-APPEARANCE-7731 freckles',
  customStoryMemory: 'ZQX-MEMORY-7731 the day at the lake',
  personName: 'ZQX-PERSON-7731',
  personNotes: 'ZQX-PERSON-NOTES-7731',
  relationship: 'ZQX-RELATIONSHIP-7731',
  photoName: 'ZQX-PHOTO-7731.jpg',
  voiceName: 'ZQX-VOICE-7731.mp3',
  mustIncludeOther: 'ZQX-MUST-INCLUDE-7731',
  focusPersonLabel: 'ZQX-FOCUS-7731',
  cropHint: 'ZQX-CROP-7731',
} as const;

const PII_TOKENS = ['ZQX-', '7731', 'zqx.parent', 'example.invalid', 'freckles', 'lake', 'Needs attention'];

const ALLOWED_EVENT_KEYS = new Set([
  'event', 'timestamp', 'href', 'pathname',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref',
  'step_id', 'step_number', 'total_steps', 'selected_format', 'reason',
]);

function adversarialForm(): CheckoutProgressFormShape {
  return {
    theme: 'custom-voice-story',
    childName: PII.childName,
    characterNotes: PII.characterNotes,
    photoFile: new File(['x'], PII.photoName, { type: 'image/jpeg' }),
    familyCharacters: [
      makePerson({
        id: 'person-zqx',
        name: PII.personName,
        notes: '', // incomplete on purpose (no notes, no photo)
        relationshipLabel: PII.relationship,
        mustIncludeOther: PII.mustIncludeOther,
        focusPersonLabel: PII.focusPersonLabel,
        cropHint: PII.cropHint,
      }),
    ],
    bookFormat: 'premium',
    email: PII.email,
    voiceFile: new File(['x'], PII.voiceName, { type: 'audio/mpeg' }),
    voiceConsent: false,
    customStoryMemory: PII.customStoryMemory,
    directMediaConsent: false,
    // No open draft: an incomplete SAVED person is what puts the person's
    // name into the machine's own summary text (see getPeopleStepDetails).
    activeSupportingCharacterDraft: null,
  };
}

test('adversarial: fake PII in every free-form field never reaches any emitted step event', async () => {
  const form = adversarialForm();
  const progress = getCheckoutProgress(form);
  // Sanity: the machine itself DOES see the PII (in summaries), so the
  // exclusion below is doing real work rather than passing vacuously.
  assert.match(JSON.stringify(progress), /ZQX-PERSON-7731/);

  const gtagCalls: unknown[][] = [];
  const storage = new Map<string, string>();
  const mockWindow = {
    location: new URL('https://herostorybooks.com/checkout?utm_source=founder&utm_medium=warm-intro&utm_campaign=friends&ref=zqxfounder'),
    gtag: (...args: unknown[]) => gtagCalls.push(args),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    hsbEvents: undefined as Array<Record<string, unknown>> | undefined,
  };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '' } });
  try {
    const { track } = await import('../src/lib/analytics.ts');
    const deduper = createCheckoutStepViewDeduper();
    for (const step of progress.steps) {
      const props = checkoutStepEventProps(step.id, form.bookFormat);
      if (deduper.shouldEmit(step.id)) track('checkout_step_view', props);
      if (deduper.shouldEmit(step.id)) track('checkout_step_view', props); // must be deduped
      const reason = checkoutStepBlockedReason(step);
      if (reason) track('checkout_step_blocked', { ...props, reason });
      else track('checkout_step_complete', props);
    }
    track('checkout_step_blocked', {
      ...checkoutStepEventProps('review', form.bookFormat),
      reason: checkoutSubmitBlockedReason({
        currentStepId: 'review',
        blockingStep: progress.currentStep,
        mediaConsentMissing: true,
      }),
    });

    const events = mockWindow.hsbEvents ?? [];
    assert.ok(events.length >= 6, `expected a full step sweep, got ${events.length} events`);
    const views = events.filter((e) => e.event === 'checkout_step_view');
    assert.equal(views.length, 4, 'one view per step, duplicates suppressed');

    const serialized = JSON.stringify({ events, gtagCalls });
    for (const token of PII_TOKENS) {
      assert.ok(!serialized.includes(token), `PII token "${token}" leaked into analytics: ${serialized}`);
    }
    for (const event of events) {
      for (const key of Object.keys(event)) {
        assert.ok(ALLOWED_EVENT_KEYS.has(key), `unexpected event field "${key}" on ${String(event.event)}`);
      }
      assert.equal(event.utm_source, 'founder', 'first-touch attribution must survive');
      assert.equal(event.utm_medium, 'warm-intro');
      assert.equal(event.ref, 'zqxfounder');
      assert.equal(event.pathname, '/checkout');
      assert.equal(event.total_steps, 4);
      assert.equal(event.selected_format, 'premium');
    }
    const blocked = events.filter((e) => e.event === 'checkout_step_blocked');
    for (const event of blocked) {
      assert.ok(
        (CHECKOUT_STEP_BLOCKED_REASONS as readonly string[]).includes(String(event.reason)),
        `reason ${String(event.reason)} is not enumerated`,
      );
    }
    const gtagEventNames = gtagCalls.filter((c) => c[0] === 'event').map((c) => c[1]);
    assert.ok(gtagEventNames.includes('checkout_step_view'));
    assert.ok(gtagEventNames.includes('checkout_step_blocked'));
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});
