import { NextRequest, NextResponse } from 'next/server';

import {
  appendFamilyContribution,
  findOrderByFamilyContributionToken,
  MAX_VOICE_BYTES,
  persistOrder,
  sanitizeFamilyContributionInput,
  uploadFamilyContributionPhoto,
  uploadFamilyContributionVoice,
} from '@/lib/orders';

const MAX_CONTRIBUTOR_PHOTO_BYTES = 10 * 1024 * 1024;

function isAttachedFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'size' in value &&
      typeof value.size === 'number' &&
      value.size > 0,
  );
}

function samePage(request: NextRequest, token: string, params?: Record<string, string>) {
  const url = new URL(`/family-contribute/${encodeURIComponent(token)}`, request.url);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const order = await findOrderByFamilyContributionToken(token);
  if (!order) {
    return NextResponse.redirect(samePage(request, token, { error: 'invalid_link' }), 303);
  }
  if (order.paymentStatus !== 'paid') {
    return NextResponse.redirect(samePage(request, token, { error: 'inactive_order' }), 303);
  }

  const form = await request.formData();
  const submittedAt = new Date().toISOString();
  const voiceFile = form.get('voiceNote');
  const photoFile = form.get('supportingCharacterPhoto');
  let contribution = sanitizeFamilyContributionInput(
    {
      contributorName: String(form.get('contributorName') || ''),
      relationship: String(form.get('relationship') || ''),
      dedication: String(form.get('dedication') || ''),
      memory: String(form.get('memory') || ''),
      storyIdea: String(form.get('storyIdea') || ''),
      supportingCharacterName: String(form.get('supportingCharacterName') || ''),
      supportingCharacterRelationship: String(form.get('supportingCharacterRelationship') || ''),
      supportingCharacterNotes: String(form.get('supportingCharacterNotes') || ''),
    },
    submittedAt,
  );

  if (
    !contribution.dedication &&
    !contribution.memory &&
    !contribution.storyIdea &&
    !contribution.supportingCharacterName &&
    !isAttachedFile(voiceFile) &&
    !isAttachedFile(photoFile)
  ) {
    return NextResponse.redirect(samePage(request, token, { error: 'empty' }), 303);
  }

  const voiceConsent = String(form.get('voiceConsent') || '') === 'on';
  const photoConsent = String(form.get('photoConsent') || '') === 'on';
  if (isAttachedFile(voiceFile)) {
    if (!voiceFile.type.startsWith('audio/')) {
      return NextResponse.redirect(samePage(request, token, { error: 'voice_type' }), 303);
    }
    if (voiceFile.size > MAX_VOICE_BYTES) {
      return NextResponse.redirect(samePage(request, token, { error: 'voice_size' }), 303);
    }
    if (!voiceConsent) {
      return NextResponse.redirect(samePage(request, token, { error: 'voice_consent' }), 303);
    }
    const uploadedVoice = await uploadFamilyContributionVoice(order.id, contribution.id, voiceFile);
    contribution = {
      ...contribution,
      voiceFileName: voiceFile.name || 'voice-note',
      voiceBlobPath: uploadedVoice?.pathname ?? null,
      voiceBlobUrl: uploadedVoice?.url ?? null,
      voiceConsentAt: submittedAt,
    };
  }

  if (isAttachedFile(photoFile)) {
    if (!photoFile.type.startsWith('image/')) {
      return NextResponse.redirect(samePage(request, token, { error: 'photo_type' }), 303);
    }
    if (photoFile.size > MAX_CONTRIBUTOR_PHOTO_BYTES) {
      return NextResponse.redirect(samePage(request, token, { error: 'photo_size' }), 303);
    }
    if (!photoConsent) {
      return NextResponse.redirect(samePage(request, token, { error: 'photo_consent' }), 303);
    }
    const uploadedPhoto = await uploadFamilyContributionPhoto(order.id, contribution.id, photoFile);
    contribution = {
      ...contribution,
      photoFileName: photoFile.name || 'supporting-character-photo',
      photoBlobPath: uploadedPhoto?.pathname ?? null,
      photoBlobUrl: uploadedPhoto?.url ?? null,
      photoConsentAt: submittedAt,
    };
  }

  await persistOrder(appendFamilyContribution(order, contribution));
  return NextResponse.redirect(samePage(request, token, { submitted: '1' }), 303);
}
