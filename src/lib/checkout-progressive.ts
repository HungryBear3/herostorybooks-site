export interface SupportingCharacterRecord {
  id: string;
  role: string;
  name: string;
  relationshipLabel: string;
  pronouns: string;
  notes: string;
  isGiftRecipient: boolean;
  appearsInStory: boolean;
  photoFile: File | null;
  photoDataUrl: string | null;
  mustInclude: string[];
  mustIncludeOther: string;
  focusPersonLabel: string;
  cropHint: string;
}

export interface SupportingCharacterEditorState {
  savedCharacters: SupportingCharacterRecord[];
  activeDraft: SupportingCharacterRecord | null;
  draftMode: 'new' | 'edit' | null;
  originalCharacter: SupportingCharacterRecord | null;
}

export interface CheckoutProgressFormShape {
  theme: string;
  childName: string;
  characterNotes: string;
  photoFile: File | null;
  familyCharacters: SupportingCharacterRecord[];
  bookFormat: string;
  email: string;
  voiceFile: File | null;
  voiceConsent: boolean;
  activeSupportingCharacterDraft?: SupportingCharacterRecord | null;
}

export interface CheckoutStepProgress {
  id: 'hero-details' | 'hero-appearance' | 'story' | 'people' | 'review';
  title: string;
  status: 'complete' | 'current' | 'upcoming' | 'needs_attention';
  complete: boolean;
  summary: string;
  missingFields: string[];
  firstInvalidField: string | null;
}

export interface CheckoutProgressState {
  steps: CheckoutStepProgress[];
  currentStep: Pick<CheckoutStepProgress, 'id' | 'title' | 'missingFields' | 'firstInvalidField'>;
}

function nextSupportingCharacterDraftId(existingIds: Set<string>) {
  let id: string;
  do {
    id = `supporting-character-${crypto.randomUUID()}`;
  } while (existingIds.has(id));
  return id;
}

function isHumanSupportingCharacter(character: SupportingCharacterRecord) {
  return character.role !== 'pet';
}

function hasHeroAppearance(form: CheckoutProgressFormShape) {
  return Boolean(form.photoFile || form.characterNotes.trim());
}

function looksLikeEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isSupportingCharacterComplete(character: SupportingCharacterRecord) {
  return supportingCharacterDraftMissingFields(character).length === 0;
}

export function createSupportingCharacterEditorState(
  savedCharacters: SupportingCharacterRecord[],
): SupportingCharacterEditorState {
  return {
    savedCharacters,
    activeDraft: null,
    draftMode: null,
    originalCharacter: null,
  };
}

export function createSupportingCharacterDraft(
  preset: Partial<SupportingCharacterRecord> & Pick<SupportingCharacterRecord, 'role' | 'relationshipLabel'>,
  options?: { existingState?: SupportingCharacterEditorState },
): SupportingCharacterRecord | null {
  if (options?.existingState?.activeDraft) return null;
  const existingIds = new Set(
    options?.existingState?.savedCharacters.map((character) => character.id) ?? [],
  );
  return {
    id: preset.id ?? nextSupportingCharacterDraftId(existingIds),
    role: preset.role,
    name: preset.name ?? '',
    relationshipLabel: preset.relationshipLabel,
    pronouns: preset.pronouns ?? '',
    notes: preset.notes ?? '',
    isGiftRecipient: preset.isGiftRecipient ?? false,
    appearsInStory: preset.appearsInStory ?? true,
    photoFile: preset.photoFile ?? null,
    photoDataUrl: preset.photoDataUrl ?? null,
    mustInclude: preset.mustInclude ?? [],
    mustIncludeOther: preset.mustIncludeOther ?? '',
    focusPersonLabel: preset.focusPersonLabel ?? '',
    cropHint: preset.cropHint ?? '',
  };
}

export function startSupportingCharacterEdit(
  state: SupportingCharacterEditorState,
  id: string,
): SupportingCharacterEditorState {
  const originalCharacter = state.savedCharacters.find((character) => character.id === id) ?? null;
  if (!originalCharacter) return state;
  return {
    ...state,
    activeDraft: { ...originalCharacter },
    draftMode: 'edit',
    originalCharacter,
  };
}

export function cancelSupportingCharacterDraft(
  state: SupportingCharacterEditorState,
): SupportingCharacterEditorState {
  return {
    ...state,
    activeDraft: null,
    draftMode: null,
    originalCharacter: null,
  };
}

export function supportingCharacterDraftMissingFields(
  character: SupportingCharacterRecord,
): string[] {
  const missing: string[] = [];
  if (!character.role.trim()) missing.push('role');
  if (!character.name.trim()) missing.push('name');
  if (isHumanSupportingCharacter(character) && !character.relationshipLabel.trim()) {
    missing.push('relationship');
  }
  if (
    isHumanSupportingCharacter(character) &&
    character.appearsInStory !== false &&
    !character.photoFile &&
    !character.notes.trim()
  ) {
    missing.push('appearance details or reference photo');
  }
  return missing;
}

export function saveSupportingCharacterDraft(
  state: SupportingCharacterEditorState,
  draft: SupportingCharacterRecord,
): { saved: boolean; state: SupportingCharacterEditorState } {
  if (supportingCharacterDraftMissingFields(draft).length > 0) {
    return { saved: false, state };
  }

  const existingIndex = state.savedCharacters.findIndex((character) => character.id === draft.id);
  if (existingIndex >= 0 && state.draftMode !== 'edit' && state.activeDraft == null) {
    return { saved: false, state };
  }

  if (existingIndex >= 0) {
    return {
      saved: true,
      state: {
        savedCharacters: state.savedCharacters.map((character) =>
          character.id === draft.id ? draft : character,
        ),
        activeDraft: null,
        draftMode: null,
        originalCharacter: null,
      },
    };
  }

  return {
    saved: true,
    state: {
      savedCharacters: [...state.savedCharacters, draft],
      activeDraft: null,
      draftMode: null,
      originalCharacter: null,
    },
  };
}

function getPeopleStepDetails(form: CheckoutProgressFormShape) {
  const activeDraft = form.activeSupportingCharacterDraft ?? null;
  if (activeDraft) {
    return {
      complete: false,
      summary: 'Finish or cancel the open person draft.',
      missingFields: ['Open person draft'],
      firstInvalidField: 'supportingCharacter.name',
      status: 'needs_attention' as const,
    };
  }

  const incompleteCharacters = form.familyCharacters.filter(
    (character) => !isSupportingCharacterComplete(character),
  );

  if (incompleteCharacters.length > 0) {
    return {
      complete: false,
      summary: `Needs attention: ${incompleteCharacters
        .map((character) => character.name || character.relationshipLabel || 'family member')
        .join(', ')}`,
      missingFields: ['Incomplete family member details'],
      firstInvalidField: 'supportingCharacter.name',
      status: 'needs_attention' as const,
    };
  }

  return {
    complete: true,
    summary: form.familyCharacters.length > 0 ? `${form.familyCharacters.length} added` : 'Optional',
    missingFields: [],
    firstInvalidField: null,
    status: 'complete' as const,
  };
}

function getStepBlueprints(form: CheckoutProgressFormShape): CheckoutStepProgress[] {
  const steps: CheckoutStepProgress[] = [
    {
      id: 'hero-details',
      title: 'Hero details',
      status: 'upcoming',
      complete: Boolean(form.theme.trim() && form.childName.trim()),
      summary: form.theme.trim() && form.childName.trim() ? 'Done' : 'Add the hero name and choose a story direction.',
      missingFields: [
        ...(form.theme.trim() ? [] : ['Story direction']),
        ...(form.childName.trim() ? [] : ["Main hero's name"]),
      ],
      firstInvalidField: !form.theme.trim() ? 'theme' : !form.childName.trim() ? 'childName' : null,
    },
    {
      id: 'hero-appearance',
      title: 'Hero photo or description',
      status: 'upcoming',
      complete: hasHeroAppearance(form),
      summary: hasHeroAppearance(form) ? 'Done' : 'Add a hero photo or written appearance details.',
      missingFields: hasHeroAppearance(form) ? [] : ['Hero appearance details or photo'],
      firstInvalidField: hasHeroAppearance(form) ? null : 'characterNotes',
    },
    {
      id: 'story',
      title: 'Story',
      status: 'upcoming',
      complete: true,
      summary: 'Optional story details are ready for review.',
      missingFields: [],
      firstInvalidField: null,
    },
    {
      id: 'people',
      title: 'People and pets',
      status: 'upcoming',
      ...getPeopleStepDetails(form),
    },
    {
      id: 'review',
      title: 'Contact, delivery, and review',
      status: 'upcoming',
      complete: false,
      summary:
        form.bookFormat.trim() && looksLikeEmail(form.email) && (!form.voiceFile || form.voiceConsent)
          ? 'Ready for payment review.'
          : 'Add contact and delivery details before payment.',
      missingFields: [
        ...(form.bookFormat.trim() ? [] : ['Book format']),
        ...(looksLikeEmail(form.email) ? [] : ['Email address']),
        ...(!form.voiceFile || form.voiceConsent ? [] : ['Voice note consent']),
      ],
      firstInvalidField: !form.bookFormat.trim()
        ? 'bookFormat'
        : !looksLikeEmail(form.email)
          ? 'email'
          : form.voiceFile && !form.voiceConsent
            ? 'voiceConsent'
            : null,
    },
  ];

  let currentIndex = steps.findIndex((step) => !step.complete || step.id === 'review');
  if (currentIndex < 0) currentIndex = steps.length - 1;

  return steps.map((step, index) => {
    if (step.status === 'needs_attention') return step;
    if (index < currentIndex) return { ...step, status: 'complete' as const };
    if (index === currentIndex) return { ...step, status: 'current' as const };
    return { ...step, status: 'upcoming' as const };
  });
}

export function getCheckoutProgress(form: CheckoutProgressFormShape): CheckoutProgressState {
  const steps = getStepBlueprints(form);
  const currentStep =
    steps.find((step) => step.status === 'needs_attention') ??
    steps.find((step) => step.status === 'current') ??
    steps[steps.length - 1];

  return {
    steps,
    currentStep: {
      id: currentStep.id,
      title: currentStep.title,
      missingFields: currentStep.missingFields,
      firstInvalidField: currentStep.firstInvalidField,
    },
  };
}

export function getCheckoutPaymentBlockers(form: CheckoutProgressFormShape): string[] {
  const steps = getStepBlueprints(form);
  return steps.flatMap((step) => step.missingFields.map((field) => `${step.title}: ${field}`));
}

export function canNavigateToCheckoutStep(
  steps: CheckoutStepProgress[],
  targetId: CheckoutStepProgress['id'],
): boolean {
  const targetIndex = steps.findIndex((step) => step.id === targetId);
  if (targetIndex < 0) return false;
  const firstIncompleteIndex = steps.findIndex((step) => !step.complete);
  if (firstIncompleteIndex < 0) return true;
  return targetIndex <= firstIncompleteIndex;
}
