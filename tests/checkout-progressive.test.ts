import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createSupportingCharacterDraft,
  createSupportingCharacterEditorState,
  saveSupportingCharacterDraft,
  cancelSupportingCharacterDraft,
  startSupportingCharacterEdit,
  supportingCharacterDraftMissingFields,
  getCheckoutProgress,
  getCheckoutPaymentBlockers,
  canNavigateToCheckoutStep,
  type CheckoutProgressFormShape,
  type SupportingCharacterRecord,
} from '../src/lib/checkout-progressive.ts';

const CHECKOUT_FORM_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

function makePerson(overrides: Partial<SupportingCharacterRecord> = {}): SupportingCharacterRecord {
  return {
    id: 'person-1',
    role: 'dad',
    name: 'Dad',
    relationshipLabel: 'Dad',
    pronouns: '',
    notes: '',
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
    ...overrides,
  };
}

test('restored supporting character ids cannot collide with a newly-created draft', () => {
  const restored = makePerson({ id: 'supporting-character-restored' });
  const state = createSupportingCharacterEditorState([restored]);
  const draft = createSupportingCharacterDraft(
    { role: 'mom', relationshipLabel: 'Mom' },
    { existingState: state },
  );
  assert.ok(draft);
  assert.notEqual(draft.id, restored.id);
  assert.match(draft.id, /^supporting-character-[0-9a-f-]{36}$/i);
});

test('checkout source fences overlapping and reset photo callbacks with operation tokens', () => {
  assert.match(CHECKOUT_FORM_SRC, /heroPhotoOperationRef\.current/);
  assert.match(CHECKOUT_FORM_SRC, /supportingPhotoOperationRef\.current/);
  assert.match(CHECKOUT_FORM_SRC, /operation !== heroPhotoOperationRef\.current/);
  assert.match(CHECKOUT_FORM_SRC, /operation !== supportingPhotoOperationRef\.current/);
  assert.match(CHECKOUT_FORM_SRC, /heroPhotoOperationRef\.current \+= 1/);
  assert.match(CHECKOUT_FORM_SRC, /supportingPhotoOperationRef\.current \+= 1/);
  const heroRemove = CHECKOUT_FORM_SRC.slice(
    CHECKOUT_FORM_SRC.indexOf('Change Photo') - 500,
    CHECKOUT_FORM_SRC.indexOf('Change Photo') + 200,
  );
  assert.match(heroRemove, /heroPhotoOperationRef\.current \+= 1/);
});

test('supporting photo completion is draft-only and cancel/remove invalidate pending work', () => {
  const processor = CHECKOUT_FORM_SRC.slice(
    CHECKOUT_FORM_SRC.indexOf('const processSupportingCharacterPhoto'),
    CHECKOUT_FORM_SRC.indexOf('const handleDrop'),
  );
  assert.doesNotMatch(processor, /setForm\s*\(/, 'async completion must not mutate a saved character');
  const cancel = CHECKOUT_FORM_SRC.slice(
    CHECKOUT_FORM_SRC.indexOf('const cancelSupportingCharacter'),
    CHECKOUT_FORM_SRC.indexOf('const saveSupportingCharacter'),
  );
  assert.match(cancel, /supportingPhotoOperationRef\.current \+= 1/);
  assert.match(cancel, /setSupportingPhotoPendingId\(null\)/);
  const removeButton = CHECKOUT_FORM_SRC.slice(
    CHECKOUT_FORM_SRC.indexOf('{supportingCharacterDraft.photoFile && ('),
    CHECKOUT_FORM_SRC.indexOf('{supportingCharacterDraft.photoDataUrl ? ('),
  );
  assert.match(removeButton, /supportingPhotoOperationRef\.current \+= 1/);
  assert.match(removeButton, /setSupportingPhotoPendingId\(null\)/);
});

test('incomplete human draft cannot save', () => {
  const draft = createSupportingCharacterDraft({ role: 'dad', relationshipLabel: 'Dad' });
  const state = createSupportingCharacterEditorState([]);

  assert.deepEqual(supportingCharacterDraftMissingFields(draft), [
    'name',
    'appearance details or reference photo',
  ]);
  assert.equal(saveSupportingCharacterDraft(state, draft).saved, false);
});

test('photo OR written appearance details satisfies human visual-reference requirement', () => {
  const withNotes = createSupportingCharacterDraft({
    role: 'mom',
    relationshipLabel: 'Mom',
    name: 'Maya',
    notes: 'long black hair and red glasses',
  });
  const withPhoto = createSupportingCharacterDraft({
    role: 'mom',
    relationshipLabel: 'Mom',
    name: 'Maya',
    photoFile: new File(['img'], 'maya.jpg', { type: 'image/jpeg' }),
  });

  assert.deepEqual(supportingCharacterDraftMissingFields(withNotes), []);
  assert.deepEqual(supportingCharacterDraftMissingFields(withPhoto), []);
});

test('pet name permits save without photo', () => {
  const draft = createSupportingCharacterDraft({
    role: 'pet',
    relationshipLabel: 'family dog',
    name: 'Brody',
  });
  const state = createSupportingCharacterEditorState([]);
  const result = saveSupportingCharacterDraft(state, draft);

  assert.equal(result.saved, true);
  assert.equal(result.state.savedCharacters.length, 1);
});

test('second add is blocked while draft open', () => {
  const state = createSupportingCharacterEditorState([]);
  const started = createSupportingCharacterDraft({ role: 'dad', relationshipLabel: 'Dad' });
  const blocked = createSupportingCharacterDraft(
    { role: 'mom', relationshipLabel: 'Mom' },
    { existingState: { ...state, activeDraft: started } },
  );

  assert.equal(blocked, null);
});

test('save appends exactly once', () => {
  const state = createSupportingCharacterEditorState([]);
  const draft = createSupportingCharacterDraft({
    role: 'dad',
    relationshipLabel: 'Dad',
    name: 'Luis',
    notes: 'tall with dark curly hair',
  });
  const firstSave = saveSupportingCharacterDraft(state, draft);
  const secondSave = saveSupportingCharacterDraft(firstSave.state, draft);

  assert.equal(firstSave.saved, true);
  assert.equal(firstSave.state.savedCharacters.length, 1);
  assert.equal(secondSave.saved, false);
  assert.equal(secondSave.state.savedCharacters.length, 1);
});

test('cancel new does not append', () => {
  const state = createSupportingCharacterEditorState([]);
  const draft = createSupportingCharacterDraft({ role: 'dad', relationshipLabel: 'Dad' });
  const result = cancelSupportingCharacterDraft({ ...state, activeDraft: draft });

  assert.equal(result.savedCharacters.length, 0);
  assert.equal(result.activeDraft, null);
});

test('cancel edit restores unchanged saved person', () => {
  const saved = makePerson({ id: 'person-1', name: 'Luis', notes: 'blue glasses' });
  const state = createSupportingCharacterEditorState([saved]);
  const editing = startSupportingCharacterEdit(state, 'person-1');
  assert.ok(editing.activeDraft);
  editing.activeDraft.name = '';
  editing.activeDraft.notes = '';

  const cancelled = cancelSupportingCharacterDraft(editing);

  assert.deepEqual(cancelled.savedCharacters, [saved]);
});

test('legacy incomplete saved person is Needs attention and blocks step/payment', () => {
  const incomplete = makePerson({ name: '', relationshipLabel: '', notes: '' });
  const progress = getCheckoutProgress(makeForm({ familyCharacters: [incomplete] }));
  const blockers = getCheckoutPaymentBlockers(makeForm({ familyCharacters: [incomplete] }));

  assert.equal(progress.steps.find((step) => step.id === 'people')?.status, 'needs_attention');
  assert.match(progress.steps.find((step) => step.id === 'people')?.summary ?? '', /Needs attention/i);
  assert.match(blockers.join(' '), /family member/i);
});

test('first invalid field mapping and focus target are stable for each step', () => {
  const heroDetails = getCheckoutProgress(makeForm({ theme: '', childName: '' }));
  const appearance = getCheckoutProgress(makeForm({ characterNotes: '', photoFile: null }));
  const review = getCheckoutProgress(makeForm({ email: '' }));

  assert.deepEqual(heroDetails.currentStep, {
    id: 'hero-details',
    title: 'Hero details',
    missingFields: ['Story direction', "Main hero's name"],
    firstInvalidField: 'theme',
  });
  assert.deepEqual(appearance.currentStep, {
    id: 'hero-appearance',
    title: 'Hero photo or description',
    missingFields: ['Hero appearance details or photo'],
    firstInvalidField: 'characterNotes',
  });
  assert.deepEqual(review.currentStep, {
    id: 'review',
    title: 'Contact, delivery, and review',
    missingFields: ['Email address'],
    firstInvalidField: 'email',
  });
});

test('optional fields do not block', () => {
  const progress = getCheckoutProgress(makeForm({
    childName: 'Emma',
    characterNotes: 'warm brown skin and short curly dark hair',
  }));

  assert.equal(progress.steps.find((step) => step.id === 'story')?.complete, true);
  assert.notEqual(progress.steps.find((step) => step.id === 'story')?.status, 'needs_attention');
});

test('completed step checkmarks/state are exposed in order', () => {
  const progress = getCheckoutProgress(makeForm());

  assert.deepEqual(progress.steps.map((step) => ({
    id: step.id,
    status: step.status,
    complete: step.complete,
  })), [
    { id: 'hero-details', status: 'complete', complete: true },
    { id: 'hero-appearance', status: 'complete', complete: true },
    { id: 'story', status: 'complete', complete: true },
    { id: 'people', status: 'complete', complete: true },
    { id: 'review', status: 'current', complete: false },
  ]);
});

test('forward navigation is locked at the first incomplete step while completed steps remain reviewable', () => {
  const initial = getCheckoutProgress(makeForm({ theme: '', childName: '', characterNotes: '' }));
  assert.equal(canNavigateToCheckoutStep(initial.steps, 'hero-details'), true);
  assert.equal(canNavigateToCheckoutStep(initial.steps, 'hero-appearance'), false);
  assert.equal(canNavigateToCheckoutStep(initial.steps, 'review'), false);

  const appearance = getCheckoutProgress(makeForm({ characterNotes: '' }));
  assert.equal(canNavigateToCheckoutStep(appearance.steps, 'hero-details'), true);
  assert.equal(canNavigateToCheckoutStep(appearance.steps, 'hero-appearance'), true);
  assert.equal(canNavigateToCheckoutStep(appearance.steps, 'story'), false);
});

test('checkout source includes early and end-of-step next-section actions without an overlay', () => {
  assert.match(CHECKOUT_FORM_SRC, /data-testid="checkout-header-continue"/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="checkout-primary-continue"/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="checkout-bottom-continue"/);
  assert.doesNotMatch(CHECKOUT_FORM_SRC, /data-testid="checkout-sticky-continue"/);
  assert.match(CHECKOUT_FORM_SRC, /Next: Add hero photo or description/);
  assert.match(CHECKOUT_FORM_SRC, /`Next: \$\{nextStep\.title\}`/);
  assert.match(CHECKOUT_FORM_SRC, /focus-visible:ring-\[#241914\]/);
  assert.match(
    CHECKOUT_FORM_SRC,
    /id="childName"[\s\S]*?data-testid="checkout-primary-continue"[\s\S]*?id="recipientName"/,
  );
  assert.match(
    CHECKOUT_FORM_SRC,
    /data-testid="checkout-bottom-continue"[\s\S]*?type="button"[\s\S]*?onClick=\{continueCurrentStep\}/,
  );
});

test('checkout makes photo the primary likeness path and description the alternative', () => {
  assert.match(CHECKOUT_FORM_SRC, /data-testid="checkout-theme-step"[\s\S]*?tabIndex=\{-1\}/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="hero-photo-primary-choice"/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="hero-photo-primary-choice"[\s\S]*?tabIndex=\{-1\}/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="hero-photo-upload-control"/);
  assert.match(CHECKOUT_FORM_SRC, /aria-label="Upload hero photo from your phone"[\s\S]*?className="peer sr-only"/);
  assert.match(CHECKOUT_FORM_SRC, /aria-label="Take a new hero photo"[\s\S]*?className="peer sr-only"/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="hero-photo-proof-example"/);
  assert.match(CHECKOUT_FORM_SRC, /Upload a photo for the best likeness/);
  assert.match(CHECKOUT_FORM_SRC, /data-testid="hero-description-alternative"/);
  assert.match(CHECKOUT_FORM_SRC, /Or describe the hero instead/);
});

test('checkout source includes progressive step UI and sequential person editor affordances', () => {
  assert.match(CHECKOUT_FORM_SRC, /Step \{currentStepIndex \+ 1\} of \{checkoutSteps.length\}/);
  assert.match(CHECKOUT_FORM_SRC, /Save person/);
  assert.match(CHECKOUT_FORM_SRC, /Cancel edit/);
  assert.match(CHECKOUT_FORM_SRC, /Needs attention/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "hero-details" \? "hidden"/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "hero-appearance" \? "hidden"/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "story" \? "hidden"/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "people" \? "hidden"/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "review" \? "hidden"/);
  assert.match(CHECKOUT_FORM_SRC, /canNavigateToCheckoutStep/);
  assert.match(CHECKOUT_FORM_SRC, /currentStepId !== "review"/);
  assert.match(CHECKOUT_FORM_SRC, /supportingPhotoPendingId === supportingCharacterDraft\.id/);
  assert.match(CHECKOUT_FORM_SRC, /This person is the gift recipient/);
  assert.match(CHECKOUT_FORM_SRC, /setGuidedFrames\(\[\]\)/);
  assert.match(
    CHECKOUT_FORM_SRC,
    /const cancelSupportingCharacter = \(\) => \{[\s\S]*?setStepError\(null\);[\s\S]*?setFieldErrors\(\{\}\);/,
  );
});
