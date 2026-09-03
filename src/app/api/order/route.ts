import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import crypto from 'node:crypto';

import {
  bindOrderCheckoutSession,
  createOrderRecord,
  isPrintFormat,
  MAX_DOCUMENT_BYTES,
  MAX_VOICE_BYTES,
  OrderPersistenceError,
  type OrderRecord,
  persistOrResumeCheckoutOrder,
  renewCheckoutLease,
  rollbackOrderMediaUploads,
  sanitizeFamilyCharacters,
  uploadOrderPhoto,
  uploadOrderDocument,
  uploadOrderSupportingPhoto,
  uploadOrderVoice,
  withOrderTransaction,
} from '@/lib/orders';
import {
  missingFieldErrorCode,
  likenessIntentForPhoto,
  missingRequiredField,
} from '@/lib/checkout-flow';
import {
  clearUntrustedSupportingPhotoMetadata,
  missingSupportingCharacterDescriptionLabels,
} from '@/lib/checkout-photo-policy';
import { buildCheckoutTracking } from '@/lib/checkout-tracking';
import { sanitizeGaClientId } from '@/lib/ga4-purchase';
import { markRecoveryLeadConverted } from '@/lib/recovery';
import { CHECKOUT_PAUSED_CODE, CHECKOUT_PAUSED_MESSAGE, isCheckoutPaused } from '@/lib/checkout-pause';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';
import { getRequiredStripeProductId } from '@/lib/stripe-products';
import { statusForShape, validateCustomStoryBrief, type CustomStoryBrief, type ValidationResult } from '@/lib/custom-story';
import { validateOrderPhotoFile } from '@/lib/photo-file-validation';
import { isDirectUploadServerEnabled } from '@/lib/checkout-direct-flags';
import { parseDirectIntakeOrderRequest } from '@/lib/checkout-direct-order-request';
import {
  buildDirectIntakeBindingDependencies,
  runDirectIntakeCheckout,
  type DirectCheckoutSessionRequest,
} from '@/lib/checkout-direct-order';
import { createVercelIntakeStore } from '@/lib/checkout-intake';
import { checkoutRequestFingerprint } from '@/lib/checkout-request-fingerprint';
import { classifyStoryAttachment } from '@/lib/story-attachment';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getStripe() {
  return new Stripe(getRequiredStripeSecretKey());
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '"true"';
}

const PRIMARY_HERO_TYPES = new Set(['child', 'parent', 'grandparent']);
const PRIMARY_HERO_BETA_ENABLED = envFlag('HSB_PRIMARY_HERO_BETA') || envFlag('NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA');
const CUSTOM_STORY_PAID_BETA_ENABLED = envFlag('HSB_CUSTOM_STORY_PAID_BETA') || envFlag('NEXT_PUBLIC_HSB_CUSTOM_STORY_PAID_BETA');


function parseCustomStoryBrief(raw: FormDataEntryValue | null): CustomStoryBrief | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as CustomStoryBrief;
  } catch {
    throw new Error('custom_story_brief_invalid_json');
  }
}

function getReturnBaseUrl(request: Request): string {
  // Production: pin Stripe success/cancel URLs to the canonical brand domain.
  // We deliberately do NOT use the inbound origin in production because
  // production may be served from herostorybooks.com or from a Vercel domain,
  // and we always want the customer to land on the branded URL.
  if (process.env.VERCEL_ENV === 'production') {
    const explicit = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '');
    if (explicit) return explicit;
    return 'https://herostorybooks.com';
  }
  // Preview / development: derive base URL from the inbound request origin
  // so Stripe returns the customer to the EXACT deployment that created the
  // Checkout Session — not a stale shared preview alias that may serve older
  // code. NEXT_PUBLIC_URL is the alias and would pin previews to whichever
  // deployment that alias currently points at, which can be older than the
  // deployment that handled this POST.
  try {
    const origin = new URL(request.url).origin;
    if (origin) return origin;
  } catch {
    // fall through to env / localhost
  }
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

export async function POST(request: Request) {
  try {
    if (isCheckoutPaused()) {
      return NextResponse.json(
        {
          error: CHECKOUT_PAUSED_MESSAGE,
          code: CHECKOUT_PAUSED_CODE,
        },
        { status: 503 },
      );
    }

    const form = await request.formData();
    const directRequest = parseDirectIntakeOrderRequest(form);
    if (directRequest.kind === 'invalid') {
      return NextResponse.json(
        { error: 'Direct upload request is incomplete or invalid. No charge was made.', code: directRequest.code },
        { status: 400 },
      );
    }
    if (directRequest.kind === 'direct' && !isDirectUploadServerEnabled()) {
      return NextResponse.json(
        { error: 'Direct upload checkout is not enabled on this deployment. No charge was made.', code: 'direct_upload_disabled' },
        { status: 503 },
      );
    }
    const directSelection = directRequest.kind === 'direct' ? directRequest.request.selection : null;
    const checkoutAttemptId = String(form.get('checkoutAttemptId') || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(checkoutAttemptId)) {
      return NextResponse.json({ error: 'Invalid checkout attempt. Please reload and try again.' }, { status: 400 });
    }
    const requestFingerprint = await checkoutRequestFingerprint(form);
    const checkoutTracking = buildCheckoutTracking({
      cohort: form.get('cohort'),
      invite: form.get('invite'),
    });
    const gaClientId = sanitizeGaClientId(form.get('gaClientId'));
    const childName = String(form.get('childName') || '').trim();
    const email = String(form.get('email') || '').trim();
    const bookFormat = String(form.get('bookFormat') || 'classic').trim();
    const theme = String(form.get('theme') || '').trim();
    const childPronouns = String(form.get('childPronouns') || '').trim();
    const customStoryText = String(form.get('customStoryText') || '').trim().slice(0, 1200);
    // Appearance details ride inside appearanceOptions. The server derives
    // hero likeness intent from actual photo presence rather than a buyer
    // toggle, so checkout cannot claim a photo-backed match when no usable
    // upload exists.
    const appearanceRaw = String(form.get('appearanceOptions') || '');
    let appearance: {
      skinTone?: string;
      hairStyle?: string;
      eyewear?: string;
      description?: string;
      mustInclude?: unknown;
      mustIncludeOther?: string;
    } = {};
    if (appearanceRaw) {
      try { appearance = JSON.parse(appearanceRaw) as typeof appearance; }
      catch { appearance = {}; }
    }
    const appearanceDescription = String(
      appearance.description || form.get('characterNotes') || '',
    ).trim();
    const photo = form.get('photo');
    const hasPhotoUpload = photo instanceof File && photo.size > 0;
    const photoValidation = hasPhotoUpload
      ? await validateOrderPhotoFile(photo)
      : { ok: false as const, code: 'photo_missing' as const };
    if (hasPhotoUpload && photoValidation.ok === false) {
      const tooLarge = photoValidation.code === 'photo_too_large';
      return NextResponse.json(
        {
          error: tooLarge
            ? 'Your hero photo is too large (max 12 MB). Please choose a smaller still image. No charge was made.'
            : 'Your hero photo must be a valid JPEG, PNG, or WebP still image. No charge was made.',
          code: photoValidation.code,
        },
        { status: tooLarge ? 413 : 400 },
      );
    }
    const photoReady = photoValidation.ok === true || directSelection?.primaryHeroPhotoAssetId != null;
    const normalizedAppearanceRaw = JSON.stringify({
      ...appearance,
      description: appearanceDescription,
      likenessIntent: likenessIntentForPhoto(photoReady),
    });

    const attachmentRaw = form.get('voice');
    const explicitDocumentRaw = form.get('document');
    const attachmentClassification = attachmentRaw instanceof File && attachmentRaw.size > 0
      ? classifyStoryAttachment(attachmentRaw)
      : null;
    const explicitDocumentClassification = explicitDocumentRaw instanceof File && explicitDocumentRaw.size > 0
      ? classifyStoryAttachment(explicitDocumentRaw)
      : null;
    if (attachmentClassification?.kind === 'invalid') {
      return NextResponse.json(
        { error: 'The story attachment type does not match its filename. No charge was made.', code: 'attachment_type_conflict' },
        { status: 400 },
      );
    }
    if (explicitDocumentClassification && explicitDocumentClassification.kind !== 'document') {
      return NextResponse.json(
        { error: 'Story document must be a coherent text, PDF, or Word file. No charge was made.', code: 'document_invalid_type' },
        { status: 400 },
      );
    }
    const legacyDocumentInVoice = attachmentClassification?.kind === 'document';
    if (legacyDocumentInVoice && explicitDocumentClassification?.kind === 'document') {
      return NextResponse.json(
        { error: 'Attach only one written story file. No charge was made.', code: 'duplicate_document_attachment' },
        { status: 400 },
      );
    }
    const voiceRaw = attachmentClassification?.kind === 'audio' ? attachmentRaw : null;
    const documentRaw = explicitDocumentClassification?.kind === 'document'
      ? explicitDocumentRaw
      : legacyDocumentInVoice
        ? attachmentRaw
        : null;
    const hasVoiceUpload = voiceRaw instanceof File && voiceRaw.size > 0;
    const hasDocumentUpload = documentRaw instanceof File && documentRaw.size > 0;
    const hasCustomStorySource = Boolean(
      customStoryText
      || hasVoiceUpload
      || hasDocumentUpload
      || directSelection?.voiceAssetId
      || directSelection?.documentAssetId,
    );
    if (theme !== 'custom-voice-story' && hasCustomStorySource) {
      return NextResponse.json(
        {
          error: 'Custom Story source material requires the Custom Story direction. No charge was made.',
          code: 'custom_story_source_theme_mismatch',
        },
        { status: 400 },
      );
    }
    const voiceConsentRaw = String(form.get('voiceConsent') || '').trim().toLowerCase();
    const voiceConsentGiven = voiceConsentRaw === 'true' || voiceConsentRaw === 'on' || voiceConsentRaw === '1';
    const documentConsentRaw = String(
      form.get('documentConsent') || (legacyDocumentInVoice ? form.get('voiceConsent') : ''),
    ).trim().toLowerCase();
    const documentConsentGiven = documentConsentRaw === 'true' || documentConsentRaw === 'on' || documentConsentRaw === '1';
    const voiceSourceRaw = String(form.get('voiceSource') || '').trim();
    const voiceSource: 'recorded' | 'uploaded' | null =
      voiceSourceRaw === 'recorded' || voiceSourceRaw === 'uploaded' ? voiceSourceRaw : null;

    if (hasVoiceUpload) {
      if (!voiceConsentGiven) {
        return NextResponse.json(
          {
            error: 'Parent/guardian consent is required to attach a voice recording.',
            code: 'voice_consent_required',
          },
          { status: 400 },
        );
      }

      const voiceFile = voiceRaw as File;
      if (classifyStoryAttachment(voiceFile).kind !== 'audio') {
        return NextResponse.json(
          { error: 'Voice attachment must be an accepted audio file.', code: 'voice_invalid_type' },
          { status: 400 },
        );
      }

      if (voiceFile.size > MAX_VOICE_BYTES) {
        return NextResponse.json(
          { error: 'Voice attachment is too large (max 15 MB).', code: 'voice_too_large' },
          { status: 400 },
        );
      }
    }

    if (hasDocumentUpload) {
      if (!documentConsentGiven) {
        return NextResponse.json(
          {
            error: 'Permission is required to attach written story material.',
            code: 'document_consent_required',
          },
          { status: 400 },
        );
      }
      const documentFile = documentRaw as File;
      if (classifyStoryAttachment(documentFile).kind !== 'document') {
        return NextResponse.json(
          { error: 'Story document must be a text, PDF, or Word file.', code: 'document_invalid_type' },
          { status: 400 },
        );
      }
      if (documentFile.size > MAX_DOCUMENT_BYTES) {
        return NextResponse.json(
          { error: 'Story document is too large (max 10 MB).', code: 'document_too_large' },
          { status: 413 },
        );
      }
    }

    const missing = missingRequiredField({
      theme,
      childName,
      email,
      appearanceDescription,
      photoReady,
    });
    if (missing !== null || !isValidEmail(email)) {
      const code = missing ? missingFieldErrorCode(missing) : 'email_invalid';
      return NextResponse.json(
        {
          error:
            code === 'email_invalid'
              ? 'A valid email is required.'
              : `Missing required field: ${code}`,
          code,
        },
        { status: 400 },
      );
    }

    const familyCharactersRaw = String(form.get('familyCharacters') || '');
    const familyCharacters = clearUntrustedSupportingPhotoMetadata(
      sanitizeFamilyCharacters(familyCharactersRaw),
    );
    const supportingPhotoFiles = new Map<number, { file: File; extension: string }>();
    for (const [index] of familyCharacters.entries()) {
      const candidate = form.get(`familyCharacterPhoto_${index}`);
      if (!(candidate instanceof File) || candidate.size <= 0) continue;
      const validation = await validateOrderPhotoFile(candidate);
      if (validation.ok === false) {
        const tooLarge = validation.code === 'photo_too_large';
        return NextResponse.json(
          {
            error: tooLarge
              ? 'A family or pet photo is too large (max 12 MB). Please choose a smaller still image. No charge was made.'
              : 'Family and pet photos must be valid JPEG, PNG, or WebP still images. No charge was made.',
            code: `supporting_${validation.code}`,
          },
          { status: tooLarge ? 413 : 400 },
        );
      }
      supportingPhotoFiles.set(index, { file: candidate, extension: validation.extension });
    }
    const supportingPhotoIndexes = directRequest.kind === 'direct'
      ? new Set(directRequest.request.selection.familyCharacterAssets.map((binding) =>
          directRequest.request.familyCharacterIds.indexOf(binding.familyCharacterId),
        ).filter((index) => index >= 0))
      : new Set(supportingPhotoFiles.keys());
    const missingSupportingDescriptions = missingSupportingCharacterDescriptionLabels(
      familyCharacters,
      supportingPhotoIndexes,
    );
    if (missingSupportingDescriptions.length > 0) {
      return NextResponse.json(
        {
          error: `Add a few written details for ${missingSupportingDescriptions.join(', ')} before payment. No charge was made.`,
          code: 'supporting_character_details_required',
        },
        { status: 400 },
      );
    }

    // Fully-custom hero contract (Phase A). All optional + backward compatible:
    // when the client only sends the legacy childName these stay empty and the
    // order record derives heroName from childName. Non-child hero TYPES are not
    // enabled in the Phase-A UI, so heroType defaults to 'child' in the record.
    const heroName = String(form.get('heroName') || '').trim();
    const rawHeroType = String(form.get('heroType') || '').trim();
    const heroType = PRIMARY_HERO_TYPES.has(rawHeroType) ? rawHeroType : 'child';
    const heroAgeOrStage = String(form.get('heroAgeOrStage') || '').trim();
    const recipientName = String(form.get('recipientName') || '').trim();
    const recipientRelationship = String(form.get('recipientRelationship') || '').trim();
    const storyPerspective = String(form.get('storyPerspective') || '').trim();
    if (heroType !== 'child') {
      if (!PRIMARY_HERO_BETA_ENABLED) {
        return NextResponse.json(
          { error: 'Non-child primary hero checkout is still in private preview.', code: 'primary_hero_beta_required' },
          { status: 400 },
        );
      }
      if (!recipientName || !recipientRelationship) {
        return NextResponse.json(
          {
            error: 'For a non-child primary hero, add who the book is for and the hero relationship before payment. No charge was made.',
            code: 'primary_hero_recipient_context_required',
          },
          { status: 400 },
        );
      }
    }
    const heroPhotoFocusLabel = String(form.get('heroPhotoFocusLabel') || '').trim();
    const heroPhotoCropHint = String(form.get('heroPhotoCropHint') || '').trim();

    let customStoryBrief: CustomStoryBrief | null = null;
    let customStoryValidation: ValidationResult | null = null;
    try {
      customStoryBrief = parseCustomStoryBrief(form.get('customStoryBrief'));
    } catch {
      return NextResponse.json(
        { error: 'Custom story brief must be valid sanitized JSON. No charge was made.', code: 'custom_story_brief_invalid_json' },
        { status: 400 },
      );
    }
    if (customStoryBrief) {
      customStoryValidation = validateCustomStoryBrief(customStoryBrief);
      const shapeStatus = customStoryValidation.ok
        ? statusForShape(customStoryBrief.storyShape)
        : null;
      if (!customStoryValidation.ok || !shapeStatus?.conciergeAllowed) {
        return NextResponse.json(
          {
            error: 'This custom story brief needs manual concierge review before checkout. No charge was made.',
            code: 'custom_story_manual_review_required',
            route: 'manual_queue',
            failures: customStoryValidation.failures,
            shapeLane: shapeStatus?.lane ?? 'not-accepted',
          },
          { status: 400 },
        );
      }
      if (!shapeStatus.sellableSelfServe && !CUSTOM_STORY_PAID_BETA_ENABLED) {
        return NextResponse.json(
          {
            error: 'This custom story shape is concierge/private-beta only. Enable the custom-story paid beta gate before checkout. No charge was made.',
            code: 'custom_story_paid_beta_required',
            shapeLane: shapeStatus.lane,
          },
          { status: 400 },
        );
      }
    }

    const draftOrder = createOrderRecord({
      childName,
      heroName: heroName || null,
      heroType: heroType || null,
      heroAgeOrStage: heroAgeOrStage || null,
      recipientName: recipientName || null,
      recipientRelationship: recipientRelationship || null,
      storyPerspective: storyPerspective || null,
      heroPhotoFocusLabel: heroPhotoFocusLabel || null,
      heroPhotoCropHint: heroPhotoCropHint || null,
      childAge: String(form.get('childAge') || ''),
      theme,
      lesson: String(form.get('lesson') || ''),
      occasion: String(form.get('occasion') || ''),
      giftMessage: String(form.get('giftMessage') || ''),
      characterNotes: String(form.get('characterNotes') || ''),
      customStoryText,
      familyCharacters,
      childPronouns: childPronouns === 'he/him' || childPronouns === 'she/her' || childPronouns === 'they/them' ? childPronouns as 'he/him' | 'she/her' | 'they/them' : '',
      appearanceOptions: normalizedAppearanceRaw,
      bookFormat,
      email,
      photoFileName: photoValidation.ok ? `hero.${photoValidation.extension}` : null,
      customStoryBrief,
      customStoryValidation,
      checkoutTracking,
    }, {
      id: `ord_${crypto.createHash('sha256').update(checkoutAttemptId).digest('hex').slice(0, 16)}`,
      // Explicit workflow intent (NOT a default): every current customer-checkout
      // order is produced on the manual path — no HSB workflow is approved as
      // automatic (DECISIONS.md:51). Never inferred from product/payment/cohort.
      fulfillmentMode: 'manual_hold',
    });
    draftOrder.checkoutAttemptId = checkoutAttemptId;
    draftOrder.checkoutFingerprint = requestFingerprint;
    draftOrder.checkoutLeaseId = crypto.randomUUID();
    draftOrder.checkoutLeaseExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    // Resolve the stable Stripe Product before creating the durable order or
    // uploading customer media. Product-scoped promotion codes depend on this
    // binding, and a missing/malformed live configuration must fail closed
    // without leaving an abandoned order or upload behind.
    const stripeProductId = getRequiredStripeProductId(draftOrder.bookFormat);

    if (directRequest.kind === 'direct') {
      let intakeStore;
      try {
        intakeStore = createVercelIntakeStore();
      } catch {
        return NextResponse.json(
          { error: 'Direct upload storage is unavailable. No charge was made.', code: 'direct_intake_store_unavailable' },
          { status: 503 },
        );
      }
      const directResult = await runDirectIntakeCheckout({
        draftOrder,
        request: directRequest.request,
        stripeProductId,
        baseUrl: getReturnBaseUrl(request),
        gaClientId,
      }, {
        binding: buildDirectIntakeBindingDependencies(intakeStore),
        createCheckoutSession: createDirectCheckoutSession,
        retrieveCheckoutSession: retrieveDirectCheckoutSession,
        bindCheckoutSession: (orderId, stripeSessionId, checkout) =>
          bindOrderCheckoutSession(orderId, stripeSessionId, checkout),
        markRecoveryLeadConverted,
        logError: (message, detail) => console.error(message, detail ?? ''),
      });
      if (directResult.status === 'refused') {
        return NextResponse.json(
          { error: directResult.error, code: directResult.code },
          { status: directResult.httpStatus },
        );
      }
      return NextResponse.json({ ok: true, redirectTo: directResult.redirectTo });
    }

    // Create the durable owner record before uploading any public customer
    // media. If cleanup itself later fails, the deterministic orders/<id>/
    // Blob prefix still has an owning record for retention/deletion handling.
    try {
      const persistedDraft = await persistOrResumeCheckoutOrder(draftOrder);
      if (persistedDraft.stripeSessionId) {
        const existingSession = await getStripe().checkout.sessions.retrieve(persistedDraft.stripeSessionId);
        if (existingSession.url && existingSession.status === 'open') {
          return NextResponse.json({ ok: true, redirectTo: existingSession.url });
        }
        return NextResponse.json({ error: 'This checkout attempt already reached payment. Contact support before retrying.' }, { status: 409 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[order] ABORT BEFORE MEDIA/STRIPE: durable draft persistence failed for ${draftOrder.id}: ${message}`);
      return NextResponse.json(
        {
          error:
            'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.',
        },
        { status: 503 },
      );
    }

    const uploadedMediaPaths: string[] = [];
    const requireActiveLease = async () => {
      const renewed = await renewCheckoutLease(
        draftOrder.id,
        draftOrder.checkoutLeaseId!,
        draftOrder.checkoutFingerprint!,
      );
      if (!renewed) throw new OrderPersistenceError(draftOrder.id, 'checkout_lease_lost');
      draftOrder.checkoutLeaseExpiresAt = renewed.checkoutLeaseExpiresAt;
    };
    const rollbackUploadedMedia = async (reason: string) => {
      if (uploadedMediaPaths.length === 0) return;
      try {
        await rollbackOrderMediaUploads(
          draftOrder.id,
          uploadedMediaPaths,
          draftOrder.checkoutLeaseId ?? undefined,
        );
        uploadedMediaPaths.length = 0;
      } catch (rollbackError) {
        // The durable draft above remains the owner-of-record even when Blob
        // deletion fails after its retry. Keep the original checkout failure
        // response while surfacing the cleanup incident for manual follow-up.
        console.error(
          `[order] MEDIA ROLLBACK FAILED for ${draftOrder.id} after ${reason}:`,
          rollbackError,
        );
      }
    };

    let photoBlobPath: string | null = null;
    let photoBlobUrl: string | null = null;
    if (photo instanceof File && photo.size > 0) {
      try {
        await requireActiveLease();
        const uploaded = await uploadOrderPhoto(draftOrder.id, photo, draftOrder.checkoutLeaseId ?? undefined);
        if (uploaded) {
          photoBlobPath = uploaded.pathname;
          photoBlobUrl = uploaded.url;
          uploadedMediaPaths.push(uploaded.pathname);
        } else {
          console.error(`[order] ABORT BEFORE STRIPE: photo upload failed for ${draftOrder.id}`);
          return NextResponse.json(
            { error: 'We could not securely save your photo. Please retry — no charge was made.' },
            { status: 503 },
          );
        }
      } catch (error) {
        // In production, OrderPersistenceError from photo upload must abort
        // BEFORE the Stripe Checkout Session — otherwise the customer pays
        // for an order whose photo is missing from durable storage.
        if (error instanceof OrderPersistenceError) {
          console.error(
            `[order] ABORT BEFORE STRIPE: photo persistence failed for ${draftOrder.id}: ${error.message}`,
            error.cause,
          );
          return NextResponse.json(
            { error: 'We could not securely save your photo. Please retry — no charge was made.' },
            { status: 503 },
          );
        }
        console.error(`[order] ABORT BEFORE STRIPE: photo upload failed for ${draftOrder.id}`, error);
        return NextResponse.json(
          { error: 'We could not securely save your photo. Please retry — no charge was made.' },
          { status: 503 },
        );
      }
    }

    const familyCharactersWithPhotos = [];
    for (const [index, character] of familyCharacters.entries()) {
      const validatedFamilyPhoto = supportingPhotoFiles.get(index);
      const familyPhoto = validatedFamilyPhoto?.file;
      if (!familyPhoto || !validatedFamilyPhoto) {
        familyCharactersWithPhotos.push(character);
        continue;
      }
      try {
        await requireActiveLease();
        const uploaded = await uploadOrderSupportingPhoto(
          draftOrder.id,
          index,
          familyPhoto,
          draftOrder.checkoutLeaseId ?? undefined,
        );
        if (!uploaded) {
          console.error(`[order] ABORT BEFORE STRIPE: supporting photo upload failed; supporting photo persistence failed for ${draftOrder.id}`);
          await rollbackUploadedMedia('supporting photo upload returned no durable reference');
          return NextResponse.json(
            {
              error:
                'We could not securely save one of your family or pet photos. Please retry — no charge was made.',
              code: 'supporting_photo_persist_failed',
            },
            { status: 503 },
          );
        }
        uploadedMediaPaths.push(uploaded.pathname);
        familyCharactersWithPhotos.push({
          ...character,
          photoFileName: `supporting-${index + 1}.${validatedFamilyPhoto.extension}`,
          photoBlobPath: uploaded.pathname,
          photoBlobUrl: uploaded.url,
          likenessIntent: 'reference' as const,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof OrderPersistenceError ? error.cause : error;
        console.error(`[order] ABORT BEFORE STRIPE: supporting photo persistence failed for ${draftOrder.id}: ${message}`, cause);
        await rollbackUploadedMedia('supporting photo persistence failure');
        return NextResponse.json(
          {
            error:
              'We could not securely save one of your family or pet photos. Please retry — no charge was made.',
            code: 'supporting_photo_persist_failed',
          },
          { status: 503 },
        );
      }
    }

    let voiceBlobPath: string | null = null;
    let voiceBlobUrl: string | null = null;
    let voiceConsentAt: string | null = null;
    if (hasVoiceUpload) {
      try {
        await requireActiveLease();
        const uploadedVoice = await uploadOrderVoice(
          draftOrder.id,
          voiceRaw as File,
          draftOrder.checkoutLeaseId ?? undefined,
        );
        if (!uploadedVoice) {
          throw new OrderPersistenceError(
            draftOrder.id,
            'Customer voice upload returned no durable reference',
          );
        }
        voiceBlobPath = uploadedVoice.pathname;
        voiceBlobUrl = uploadedVoice.url;
        voiceConsentAt = new Date().toISOString();
        uploadedMediaPaths.push(uploadedVoice.pathname);
      } catch (error) {
        // Match the photo path: an OrderPersistenceError on voice persistence
        // must abort BEFORE Stripe, so no customer pays for an order whose
        // consented audio note was dropped.
        if (error instanceof OrderPersistenceError) {
          console.error(
            `[order] ABORT BEFORE STRIPE: voice persistence failed for ${draftOrder.id}: ${error.message}`,
            error.cause,
          );
          await rollbackUploadedMedia('voice persistence failure');
          return NextResponse.json(
            {
              error:
                'We could not securely save your voice recording, so we stopped before payment. No charge was made and the recording was not saved — please download it from the checkout page and try again.',
              code: 'voice_persist_failed',
            },
            { status: 503 },
          );
        }
        console.error(`[order] voice upload failed for ${draftOrder.id}; aborting`, error);
        await rollbackUploadedMedia('voice upload failure');
        return NextResponse.json(
          {
            error:
              'We could not securely save your voice recording, so we stopped before payment. No charge was made and the recording was not saved — please download it from the checkout page and try again.',
            code: 'voice_persist_failed',
          },
          { status: 503 },
        );
      }
    }

    let documentBlobPath: string | null = null;
    let documentBlobUrl: string | null = null;
    let documentConsentAt: string | null = null;
    if (hasDocumentUpload) {
      try {
        await requireActiveLease();
        const uploadedDocument = await uploadOrderDocument(
          draftOrder.id,
          documentRaw as File,
          draftOrder.checkoutLeaseId ?? undefined,
        );
        if (!uploadedDocument) {
          throw new OrderPersistenceError(
            draftOrder.id,
            'Customer document upload returned no durable reference',
          );
        }
        documentBlobPath = uploadedDocument.pathname;
        documentBlobUrl = uploadedDocument.url;
        documentConsentAt = new Date().toISOString();
        uploadedMediaPaths.push(uploadedDocument.pathname);
      } catch (error) {
        console.error(`[order] ABORT BEFORE STRIPE: document persistence failed for ${draftOrder.id}`, error);
        await rollbackUploadedMedia('document persistence failure');
        return NextResponse.json(
          {
            error: 'We could not securely save your story document, so we stopped before payment. No charge was made. Please try again.',
            code: 'document_persist_failed',
          },
          { status: 503 },
        );
      }
    }

    // Persist the order record durably. If this throws OrderPersistenceError
    // we MUST NOT create a Stripe Checkout Session — the customer would pay
    // for an order the webhook + status page can never find.
    let order;
    try {
      order = await withOrderTransaction<OrderRecord | null>(draftOrder.id, (current) => {
        if (current.checkoutLeaseId !== draftOrder.checkoutLeaseId
          || current.checkoutFingerprint !== draftOrder.checkoutFingerprint) {
          return { abort: null };
        }
        const updated = {
          ...current,
          familyCharacters: familyCharactersWithPhotos,
          photoBlobPath,
          photoBlobUrl,
          voiceBlobPath,
          voiceBlobUrl,
          voiceConsentAt,
          voiceSource: hasVoiceUpload ? voiceSource : null,
          documentBlobPath,
          documentBlobUrl,
          documentConsentAt,
          documentSource: hasDocumentUpload ? 'uploaded' as const : null,
        };
        return { commit: updated, result: updated };
      });
      if (!order) throw new OrderPersistenceError(draftOrder.id, 'checkout_lease_lost');
    } catch (error) {
      await rollbackUploadedMedia('final order persistence failure');
      if (error instanceof OrderPersistenceError) {
        console.error(
          `[order] ABORT BEFORE STRIPE: durable order persistence failed for ${draftOrder.id}: ${error.message}`,
          error.cause,
        );
        return NextResponse.json(
          {
            error:
              'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.',
          },
          { status: 503 },
        );
      }
      throw error;
    }

    markRecoveryLeadConverted(order.email, order.id).catch(() => {});

    const stripe = getStripe();
    const baseUrl = getReturnBaseUrl(request);
    const successParams = new URLSearchParams({
      orderId: order.id,
      childName: order.heroName ?? order.childName,
      format: order.formatLabel,
      email: order.email,
    });

    await requireActiveLease();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      allow_promotion_codes: true,
      customer_email: order.email,
      client_reference_id: order.id,
      metadata: {
        orderId: order.id,
        ...(gaClientId ? { gaClientId } : {}),
        ...(order.checkoutTracking?.cohort ? { cohort: order.checkoutTracking.cohort } : {}),
        ...(order.checkoutTracking?.invite ? { invite: order.checkoutTracking.invite } : {}),
      },
      // Reversal events expose the PaymentIntent/Charge rather than the
      // Checkout Session. Copy the opaque local identity onto the PI so signed
      // refund/dispute events can converge without a Stripe lookup.
      payment_intent_data: { metadata: { orderId: order.id } },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: order.priceCents,
            product: stripeProductId,
          },
          quantity: 1,
        },
      ],
      ...(isPrintFormat(order.bookFormat)
        ? { shipping_address_collection: { allowed_countries: ['US'] } }
        : {}),
      // Stripe replaces this literal placeholder after successful Checkout.
      // Keep it outside URLSearchParams so the braces are not percent-encoded.
      // The opaque Session id enables a server-side fallback when the webhook
      // is delayed; it is never trusted without exact order/amount checks.
      success_url: `${baseUrl}/thank-you?${successParams.toString()}&sessionId={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout`,
    }, { idempotencyKey: `hsb_checkout_${order.id}` });

    const bound = await bindOrderCheckoutSession(order.id, session.id, {
      leaseId: draftOrder.checkoutLeaseId!,
      fingerprint: draftOrder.checkoutFingerprint!,
    });
    if (!bound) {
      console.error(`[order] Stripe Session ${session.id} created but durable binding failed for ${order.id}`);
      return NextResponse.json(
        { error: 'Checkout requires reconciliation. No checkout link was released.' },
        { status: 503 },
      );
    }

    return NextResponse.json({ ok: true, redirectTo: session.url });
  } catch (error) {
    console.error('Order error:', error);
    return NextResponse.json({ error: 'Order submission failed' }, { status: 500 });
  }
}

async function retrieveDirectCheckoutSession(sessionId: string) {
  return getStripe().checkout.sessions.retrieve(sessionId);
}

async function createDirectCheckoutSession(request: DirectCheckoutSessionRequest) {
  const { order, stripeProductId, baseUrl, gaClientId, idempotencyKey } = request;
  const successParams = new URLSearchParams({
    orderId: order.id,
    childName: order.heroName ?? order.childName,
    format: order.formatLabel,
    email: order.email,
  });
  return getStripe().checkout.sessions.create({
    mode: 'payment',
    allow_promotion_codes: true,
    customer_email: order.email,
    client_reference_id: order.id,
    metadata: {
      orderId: order.id,
      ...(gaClientId ? { gaClientId } : {}),
      ...(order.checkoutTracking?.cohort ? { cohort: order.checkoutTracking.cohort } : {}),
      ...(order.checkoutTracking?.invite ? { invite: order.checkoutTracking.invite } : {}),
    },
    payment_intent_data: { metadata: { orderId: order.id } },
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: order.priceCents,
        product: stripeProductId,
      },
      quantity: 1,
    }],
    ...(isPrintFormat(order.bookFormat)
      ? { shipping_address_collection: { allowed_countries: ['US'] as const } }
      : {}),
    success_url: `${baseUrl}/thank-you?${successParams.toString()}&sessionId={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout`,
  }, { idempotencyKey });
}
