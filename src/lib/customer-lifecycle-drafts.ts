export type LifecycleDraftKind = 'proof-reminder' | 'review-request' | 'referral-invitation';

export interface CustomerLifecycleDraft {
  kind: LifecycleDraftKind;
  subject: string;
  text: string;
}

interface DraftInput {
  childName: string;
  statusUrl: string;
  supportEmail: string;
}

export function buildProofReminderDraft(input: DraftInput): CustomerLifecycleDraft {
  return {
    kind: 'proof-reminder',
    subject: `${input.childName}'s storybook proof is waiting for your review`,
    text: [
      `Your private proof for ${input.childName}'s storybook is ready.`,
      'Please review every page and send any change notes before approving the full book.',
      'Nothing enters print until the proof is approved.',
      `Review the proof: ${input.statusUrl}`,
      `Questions? ${input.supportEmail}`,
    ].join('\n\n'),
  };
}

export function buildReviewRequestDraft(input: DraftInput): CustomerLifecycleDraft {
  return {
    kind: 'review-request',
    subject: `How did ${input.childName}'s storybook turn out?`,
    text: [
      `We hope ${input.childName}'s storybook feels like a keepsake your family will enjoy.`,
      'If you have a moment, reply with what worked and what we could improve.',
      'Please do not include private child photos or personal details in a public review.',
      `Need help with the order instead? ${input.supportEmail}`,
    ].join('\n\n'),
  };
}

export function buildReferralInvitationDraft(input: DraftInput): CustomerLifecycleDraft {
  return {
    kind: 'referral-invitation',
    subject: 'Know another child who would love to be the hero?',
    text: [
      `If ${input.childName}'s story made someone smile, you can share HeroStoryBooks with another family.`,
      'Each family starts their own private order and reviews the complete proof before approval.',
      'Only share your referral link with people you know. Never share a child’s photos or private proof.',
      `Questions? ${input.supportEmail}`,
    ].join('\n\n'),
  };
}
