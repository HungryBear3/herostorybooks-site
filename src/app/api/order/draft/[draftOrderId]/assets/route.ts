import { NextResponse } from 'next/server';

import { evaluateCheckoutAccessGate } from '@/lib/checkout-access-gate';
import { addIntakeAsset, getIntakeDraft, type IntakeAssetCategory } from '@/lib/order-intake';

function consentGiven(value: FormDataEntryValue | null) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === 'on' || normalized === '1';
}

const CATEGORIES = new Set<IntakeAssetCategory>([
  'primary_photo',
  'guided_child_reference',
  'supporting_character_reference',
  'voice_inspiration',
  'document_inspiration',
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftOrderId: string }> },
) {
  const { draftOrderId } = await params;
  try {
    const form = await request.formData();
    const rawCategory = String(form.get('category') ?? '').trim() as IntakeAssetCategory;
    if (!CATEGORIES.has(rawCategory)) {
      return NextResponse.json({ error: 'Unknown asset category. You have not been charged.', code: 'asset_category_invalid' }, { status: 400 });
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size <= 0) {
      return NextResponse.json({ error: 'Missing upload file. You have not been charged.', code: 'asset_missing' }, { status: 400 });
    }
    const draft = await getIntakeDraft(draftOrderId);
    if (!draft) {
      return NextResponse.json({ error: 'Draft order not found. You have not been charged.', code: 'draft_not_found' }, { status: 404 });
    }
    const gate = await evaluateCheckoutAccessGate(draft.fields.email, 'order-draft-assets');
    if (gate.ok === false) return NextResponse.json(gate.body, { status: gate.status });
    const guidedPhotoConsent = consentGiven(form.get('guidedPhotoConsent'));
    if (rawCategory === 'guided_child_reference' && !guidedPhotoConsent) {
      return NextResponse.json(
        { error: 'Parent/guardian photo consent is required before uploading guided reference photos. You have not been charged.', code: 'guided_photo_consent_required' },
        { status: 400 },
      );
    }
    const supportingPhotoConsent = consentGiven(form.get('supportingPhotoConsent')) || consentGiven(form.get('photoConsent'));
    if (rawCategory === 'supporting_character_reference' && !supportingPhotoConsent) {
      return NextResponse.json(
        { error: 'Please confirm you have permission to share each family or pet reference photo for private book prep. You have not been charged.', code: 'supporting_photo_consent_required' },
        { status: 400 },
      );
    }
    if ((rawCategory === 'voice_inspiration' || rawCategory === 'document_inspiration') && !consentGiven(form.get('voiceConsent'))) {
      return NextResponse.json(
        { error: 'Parent/guardian consent is required to attach story inspiration. You have not been charged.', code: 'voice_consent_required' },
        { status: 400 },
      );
    }
    const familyCharacterIndexRaw = form.get('familyCharacterIndex');
    const familyCharacterIndex = familyCharacterIndexRaw === null || String(familyCharacterIndexRaw).trim() === ''
      ? null
      : Number.parseInt(String(familyCharacterIndexRaw), 10);
    const { asset } = await addIntakeAsset({
      draftId: draftOrderId,
      category: rawCategory,
      file,
      guidedPhotoConsent,
      supportingPhotoConsent,
      label: String(form.get('label') ?? rawCategory),
      familyCharacterId: form.get('familyCharacterId') ? String(form.get('familyCharacterId')) : null,
      familyCharacterIndex: Number.isInteger(familyCharacterIndex) ? familyCharacterIndex : null,
      source: form.get('source') === 'recorded' ? 'recorded' : form.get('source') === 'guided_capture' ? 'guided_capture' : 'upload',
      // Reload/resume-safe dedupe key (stable per-file client id). When the
      // client re-sends the same file (lost response / resume), the server
      // returns the existing asset instead of duplicating.
      localId: form.get('localId') ? String(form.get('localId')) : null,
    });
    return NextResponse.json({ ok: true, asset });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 503;
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'asset_persist_failed';
    const message = error instanceof Error && error.message ? error.message : 'We could not securely save that asset. You have not been charged. Please retry or remove that file.';
    console.error(`[order-draft-assets] failed draft=${draftOrderId}`, error);
    return NextResponse.json({ error: message, code }, { status });
  }
}
