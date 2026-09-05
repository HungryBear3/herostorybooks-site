/**
 * The production `POST /api/order` handler, as a function that can actually be
 * executed by a test.
 *
 * WHY THIS IS A MODULE AND NOT THE ROUTE FILE
 * -------------------------------------------
 * `src/app/api/order/route.ts` imports `next/server` and the Stripe SDK, so it
 * cannot be imported under `node:test`. For as long as the handler's control
 * flow lived there, NOTHING could show that a given line was reachable — and
 * that gap was not theoretical. In review, the production call into the legacy
 * resume/recovery orchestration was changed to
 *
 *     if (false) return await runLegacyCheckoutRoute<NextResponse>({ … })
 *
 * and all 31 tests across both wiring suites still passed: the lexical guards
 * still found the call, and the behavioural tests were driving a detached copy
 * of the orchestration rather than the handler that must reach it. The whole
 * pre-media recovery — the thing that stops a buyer with an expired Session
 * from being tombstoned, and stops a second payable Session from being minted
 * behind a lost one — was unreachable in production and invisible to the suite.
 *
 * So the handler lives here, whole, and the route is a thin instantiation of it
 * with the real adapters. Only the boundaries that cannot exist under
 * `node:test` are injected: the response constructor (`NextResponse.json`), the
 * provider adapters (Stripe), the Blob-backed media uploads, the intake store,
 * and the recovery-lead write. Everything else — validation, the durable order
 * CAS, the shared provisioner — is the real code, exercised as the route runs
 * it, so a mutation that skips a step fails a behavioural test rather than a
 * regex.
 *
 * Generic in the response type so the route keeps returning real
 * `NextResponse`s and this module keeps knowing nothing about Next.
 */
import crypto from 'node:crypto';

import {
  beginCheckoutSessionProvisioning,
  bindOrderCheckoutSession,
  createOrderRecord,
  MAX_DOCUMENT_BYTES,
  MAX_VOICE_BYTES,
  OrderPersistenceError,
  type OrderRecord,
  persistOrResumeCheckoutOrder,
  recordCheckoutSessionCandidate,
  renewCheckoutLease,
  supersedeExpiredCheckoutSession,
  sanitizeFamilyCharacters,
  type UploadedPhotoRef,
  type UploadedVoiceRef,
  withOrderTransaction,
} from './orders.ts';
import {
  missingFieldErrorCode,
  likenessIntentForPhoto,
  missingRequiredField,
} from './checkout-flow.ts';
import {
  clearUntrustedSupportingPhotoMetadata,
  missingSupportingCharacterDescriptionLabels,
} from './checkout-photo-policy.ts';
import { buildCheckoutTracking } from './checkout-tracking.ts';
import { sanitizeGaClientId } from './ga4-purchase.ts';
import { CHECKOUT_PAUSED_CODE, CHECKOUT_PAUSED_MESSAGE, isCheckoutPaused } from './checkout-pause.ts';
import { getRequiredStripeProductId } from './stripe-products.ts';
import { statusForShape, validateCustomStoryBrief, type CustomStoryBrief, type ValidationResult } from './custom-story/index.ts';
import { validateOrderPhotoFile } from './photo-file-validation.ts';
import { isDirectUploadServerEnabled } from './checkout-direct-flags.ts';
import { parseDirectIntakeOrderRequest } from './checkout-direct-order-request.ts';
import {
  buildDirectIntakeBindingDependencies,
  runDirectIntakeCheckout,
} from './checkout-direct-order.ts';
import {
  provisionCheckoutSession,
  type CheckoutSessionProvisionDeps,
} from './checkout-session-provisioning.ts';
import { runLegacyCheckoutRoute } from './checkout-legacy-order.ts';
import { type IntakeStore } from './checkout-intake.ts';
import { checkoutRequestFingerprint } from './checkout-request-fingerprint.ts';
import { classifyStoryAttachment } from './story-attachment.ts';

/**
 * Everything the handler cannot construct for itself under `node:test`.
 *
 * Deliberately NOT in here: the durable order primitives and the shared
 * provisioning machine. Those are the behaviour under test — a handler that
 * could be handed a different order CAS would prove nothing about the one
 * production uses — and the order store is already swappable at its own seam.
 */
export interface CheckoutOrderRouteDeps<TResponse> {
  /** Build the route's response object. Wired to NextResponse.json. */
  json(body: Record<string, unknown>, httpStatus: number): TResponse;
  /** The provider adapters. Wired to the Stripe SDK in the route. */
  createCheckoutSession: CheckoutSessionProvisionDeps['createCheckoutSession'];
  retrieveCheckoutSession: CheckoutSessionProvisionDeps['retrieveCheckoutSession'];
  /** The private intake store. Throws when direct upload storage is unusable. */
  createIntakeStore(): IntakeStore;
  uploadOrderPhoto(orderId: string, file: File, leaseId?: string): Promise<UploadedPhotoRef | null>;
  uploadOrderSupportingPhoto(
    orderId: string,
    index: number,
    file: File,
    leaseId?: string,
  ): Promise<UploadedPhotoRef | null>;
  uploadOrderVoice(orderId: string, file: File, leaseId?: string): Promise<UploadedVoiceRef | null>;
  uploadOrderDocument(orderId: string, file: File, leaseId?: string): Promise<UploadedVoiceRef | null>;
  rollbackOrderMediaUploads(orderId: string, pathnames: string[], leaseId?: string): Promise<number>;
  markRecoveryLeadConverted(email: string, orderId: string): Promise<unknown>;
  logError(message: string, detail?: unknown): void;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '"true"';
}

const PRIMARY_HERO_TYPES = new Set(['child', 'parent', 'grandparent', 'other']);
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

export function getReturnBaseUrl(request: Request): string {
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

export async function handleCheckoutOrderPost<TResponse>(
  request: Request,
  deps: CheckoutOrderRouteDeps<TResponse>,
): Promise<TResponse> {
  const json = deps.json;
  const logError = deps.logError;
  try {
    if (isCheckoutPaused()) {
      return json(
        {
          error: CHECKOUT_PAUSED_MESSAGE,
          code: CHECKOUT_PAUSED_CODE,
        },
        503,
      );
    }

    const form = await request.formData();
    const directRequest = parseDirectIntakeOrderRequest(form);
    if (directRequest.kind === 'invalid') {
      return json(
        { error: 'Direct upload request is incomplete or invalid. No charge was made.', code: directRequest.code },
        400,
      );
    }
    if (directRequest.kind === 'direct' && !isDirectUploadServerEnabled()) {
      return json(
        { error: 'Direct upload checkout is not enabled on this deployment. No charge was made.', code: 'direct_upload_disabled' },
        503,
      );
    }
    const directSelection = directRequest.kind === 'direct' ? directRequest.request.selection : null;
    const checkoutAttemptId = String(form.get('checkoutAttemptId') || '').trim();
    if (!/^[a-f0-9]{32}$/i.test(checkoutAttemptId)) {
      return json({ error: 'Invalid checkout attempt. Please reload and try again.' }, 400);
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
      return json(
        {
          error: tooLarge
            ? 'Your hero photo is too large (max 12 MB). Please choose a smaller still image. No charge was made.'
            : 'Your hero photo must be a valid JPEG, PNG, or WebP still image. No charge was made.',
          code: photoValidation.code,
        },
        tooLarge ? 413 : 400,
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
      return json(
        { error: 'The story attachment type does not match its filename. No charge was made.', code: 'attachment_type_conflict' },
        400,
      );
    }
    if (explicitDocumentClassification && explicitDocumentClassification.kind !== 'document') {
      return json(
        { error: 'Story document must be a coherent text, PDF, or Word file. No charge was made.', code: 'document_invalid_type' },
        400,
      );
    }
    const legacyDocumentInVoice = attachmentClassification?.kind === 'document';
    if (legacyDocumentInVoice && explicitDocumentClassification?.kind === 'document') {
      return json(
        { error: 'Attach only one written story file. No charge was made.', code: 'duplicate_document_attachment' },
        400,
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
      return json(
        {
          error: 'Custom Story source material requires the Custom Story direction. No charge was made.',
          code: 'custom_story_source_theme_mismatch',
        },
        400,
      );
    }
    if (theme === 'custom-voice-story' && !hasCustomStorySource) {
      return json(
        {
          error: 'Add one Custom Story source: type a memory, record or upload audio, or attach a written file. No charge was made.',
          code: 'custom_story_source_required',
        },
        400,
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
        return json(
          {
            error: 'Parent/guardian consent is required to attach a voice recording.',
            code: 'voice_consent_required',
          },
          400,
        );
      }

      const voiceFile = voiceRaw as File;
      if (classifyStoryAttachment(voiceFile).kind !== 'audio') {
        return json(
          { error: 'Voice attachment must be an accepted audio file.', code: 'voice_invalid_type' },
          400,
        );
      }

      if (voiceFile.size > MAX_VOICE_BYTES) {
        return json(
          { error: 'Voice attachment is too large (max 15 MB).', code: 'voice_too_large' },
          400,
        );
      }
    }

    if (hasDocumentUpload) {
      if (!documentConsentGiven) {
        return json(
          {
            error: 'Permission is required to attach written story material.',
            code: 'document_consent_required',
          },
          400,
        );
      }
      const documentFile = documentRaw as File;
      if (classifyStoryAttachment(documentFile).kind !== 'document') {
        return json(
          { error: 'Story document must be a text, PDF, or Word file.', code: 'document_invalid_type' },
          400,
        );
      }
      if (documentFile.size > MAX_DOCUMENT_BYTES) {
        return json(
          { error: 'Story document is too large (max 10 MB).', code: 'document_too_large' },
          413,
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
      return json(
        {
          error:
            code === 'email_invalid'
              ? 'A valid email is required.'
              : `Missing required field: ${code}`,
          code,
        },
        400,
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
        return json(
          {
            error: tooLarge
              ? 'A family or pet photo is too large (max 12 MB). Please choose a smaller still image. No charge was made.'
              : 'Family and pet photos must be valid JPEG, PNG, or WebP still images. No charge was made.',
            code: `supporting_${validation.code}`,
          },
          tooLarge ? 413 : 400,
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
      return json(
        {
          error: `Add a few written details for ${missingSupportingDescriptions.join(', ')} before payment. No charge was made.`,
          code: 'supporting_character_details_required',
        },
        400,
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
        return json(
          { error: 'Non-child primary hero checkout is still in private preview.', code: 'primary_hero_beta_required' },
          400,
        );
      }
      if (!recipientName || !recipientRelationship) {
        return json(
          {
            error: 'For a non-child primary hero, add who the book is for and the hero relationship before payment. No charge was made.',
            code: 'primary_hero_recipient_context_required',
          },
          400,
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
      return json(
        { error: 'Custom story brief must be valid sanitized JSON. No charge was made.', code: 'custom_story_brief_invalid_json' },
        400,
      );
    }
    if (customStoryBrief) {
      customStoryValidation = validateCustomStoryBrief(customStoryBrief);
      const shapeStatus = customStoryValidation.ok
        ? statusForShape(customStoryBrief.storyShape)
        : null;
      if (!customStoryValidation.ok || !shapeStatus?.conciergeAllowed) {
        return json(
          {
            error: 'This custom story brief needs manual concierge review before checkout. No charge was made.',
            code: 'custom_story_manual_review_required',
            route: 'manual_queue',
            failures: customStoryValidation.failures,
            shapeLane: shapeStatus?.lane ?? 'not-accepted',
          },
          400,
        );
      }
      if (!shapeStatus.sellableSelfServe && !CUSTOM_STORY_PAID_BETA_ENABLED) {
        return json(
          {
            error: 'This custom story shape is concierge/private-beta only. Enable the custom-story paid beta gate before checkout. No charge was made.',
            code: 'custom_story_paid_beta_required',
            shapeLane: shapeStatus.lane,
          },
          400,
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
        intakeStore = deps.createIntakeStore();
      } catch {
        return json(
          { error: 'Direct upload storage is unavailable. No charge was made.', code: 'direct_intake_store_unavailable' },
          503,
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
        createCheckoutSession: deps.createCheckoutSession,
        retrieveCheckoutSession: deps.retrieveCheckoutSession,
        // The real guarded transactions. The saga must never re-implement
        // either check locally: only the store can settle who holds the lease.
        renewCheckoutLease: (orderId, leaseId, fingerprint) =>
          renewCheckoutLease(orderId, leaseId, fingerprint),
        beginCheckoutSessionProvisioning: (orderId, checkout) =>
          beginCheckoutSessionProvisioning(orderId, checkout),
        recordCheckoutSessionCandidate: (orderId, stripeSessionId, checkout) =>
          recordCheckoutSessionCandidate(orderId, stripeSessionId, checkout),
        supersedeCheckoutSession: (orderId, expiredStripeSessionId, checkout) =>
          supersedeExpiredCheckoutSession(orderId, expiredStripeSessionId, checkout),
        bindCheckoutSession: (orderId, stripeSessionId, checkout) =>
          bindOrderCheckoutSession(orderId, stripeSessionId, checkout),
        markRecoveryLeadConverted: deps.markRecoveryLeadConverted,
        logError,
      });
      if (directResult.status === 'refused') {
        return json(
          { error: directResult.error, code: directResult.code },
          directResult.httpStatus,
        );
      }
      return json({ ok: true, redirectTo: directResult.redirectTo }, 200);
    }

    // The legacy path's durable order primitives, wired once. The saga must
    // never re-implement any of these checks locally: only the store can settle
    // who holds the lease, and only the shared machine may decide what an
    // existing provider Session means.
    const legacyCheckoutDeps = {
      createCheckoutSession: deps.createCheckoutSession,
      retrieveCheckoutSession: deps.retrieveCheckoutSession,
      renewCheckoutLease: (orderId: string, leaseId: string, fingerprint: string) =>
        renewCheckoutLease(orderId, leaseId, fingerprint),
      beginCheckoutSessionProvisioning: (
        orderId: string,
        checkout: { leaseId: string; fingerprint: string; checkoutSessionAttempt: number },
      ) => beginCheckoutSessionProvisioning(orderId, checkout),
      recordCheckoutSessionCandidate: (
        orderId: string,
        stripeSessionId: string,
        checkout: { checkoutAttemptId: string; fingerprint: string; checkoutSessionAttempt: number },
      ) => recordCheckoutSessionCandidate(orderId, stripeSessionId, checkout),
      supersedeCheckoutSession: (
        orderId: string,
        expiredStripeSessionId: string,
        checkout: { leaseId: string; fingerprint: string },
      ) => supersedeExpiredCheckoutSession(orderId, expiredStripeSessionId, checkout),
      bindCheckoutSession: (
        orderId: string,
        stripeSessionId: string,
        checkout: { leaseId: string; fingerprint: string; checkoutSessionAttempt: number },
      ) => bindOrderCheckoutSession(orderId, stripeSessionId, checkout),
      logError,
    };

    // Create the durable owner record before uploading any public customer
    // media. If cleanup itself later fails, the deterministic orders/<id>/
    // Blob prefix still has an owning record for retention/deletion handling.
    //
    // This entrypoint also owns the ONLY question this handler used to answer
    // for itself: what to do about an order that already has provider history.
    // It used to retrieve that Session inline and return its URL or a flat 409,
    // which permanently tombstoned any attempt whose Session had expired and
    // was blind to a Session created but never bound. Both paths now recover
    // through the same machine. See lib/checkout-legacy-order.ts.
    return await runLegacyCheckoutRoute<TResponse>({
      draftOrder,
      stripeProductId,
      baseUrl: getReturnBaseUrl(request),
      gaClientId,
    }, {
      ...legacyCheckoutDeps,
      persistOrResumeCheckoutOrder: (order) => persistOrResumeCheckoutOrder(order),
      json,
      // Reached ONLY for an order with no provider history of any kind. Every
      // resumable order — bound Session, unbound candidate, provisioning marker
      // — is answered by the entrypoint above, before a single byte of customer
      // media is uploaded and without this handler deciding anything about it.
      continueWithMedia: async (persisted) => {
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
          await deps.rollbackOrderMediaUploads(
            draftOrder.id,
            uploadedMediaPaths,
            draftOrder.checkoutLeaseId ?? undefined,
          );
          uploadedMediaPaths.length = 0;
        } catch (rollbackError) {
          // The durable draft above remains the owner-of-record even when Blob
          // deletion fails after its retry. Keep the original checkout failure
          // response while surfacing the cleanup incident for manual follow-up.
          logError(
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
          const uploaded = await deps.uploadOrderPhoto(draftOrder.id, photo, draftOrder.checkoutLeaseId ?? undefined);
          if (uploaded) {
            photoBlobPath = uploaded.pathname;
            photoBlobUrl = uploaded.url;
            uploadedMediaPaths.push(uploaded.pathname);
          } else {
            logError(`[order] ABORT BEFORE STRIPE: photo upload failed for ${draftOrder.id}`);
            return json(
              { error: 'We could not securely save your photo. Please retry — no charge was made.' },
              503,
            );
          }
        } catch (error) {
          // In production, OrderPersistenceError from photo upload must abort
          // BEFORE the Stripe Checkout Session — otherwise the customer pays
          // for an order whose photo is missing from durable storage.
          if (error instanceof OrderPersistenceError) {
            logError(
              `[order] ABORT BEFORE STRIPE: photo persistence failed for ${draftOrder.id}: ${error.message}`,
              error.cause,
            );
            return json(
              { error: 'We could not securely save your photo. Please retry — no charge was made.' },
              503,
            );
          }
          logError(`[order] ABORT BEFORE STRIPE: photo upload failed for ${draftOrder.id}`, error);
          return json(
            { error: 'We could not securely save your photo. Please retry — no charge was made.' },
            503,
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
          const uploaded = await deps.uploadOrderSupportingPhoto(
            draftOrder.id,
            index,
            familyPhoto,
            draftOrder.checkoutLeaseId ?? undefined,
          );
          if (!uploaded) {
            logError(`[order] ABORT BEFORE STRIPE: supporting photo upload failed; supporting photo persistence failed for ${draftOrder.id}`);
            await rollbackUploadedMedia('supporting photo upload returned no durable reference');
            return json(
              {
                error:
                  'We could not securely save one of your family or pet photos. Please retry — no charge was made.',
                code: 'supporting_photo_persist_failed',
              },
              503,
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
          logError(`[order] ABORT BEFORE STRIPE: supporting photo persistence failed for ${draftOrder.id}: ${message}`, cause);
          await rollbackUploadedMedia('supporting photo persistence failure');
          return json(
            {
              error:
                'We could not securely save one of your family or pet photos. Please retry — no charge was made.',
              code: 'supporting_photo_persist_failed',
            },
            503,
          );
        }
      }

      let voiceBlobPath: string | null = null;
      let voiceBlobUrl: string | null = null;
      let voiceConsentAt: string | null = null;
      if (hasVoiceUpload) {
        try {
          await requireActiveLease();
          const uploadedVoice = await deps.uploadOrderVoice(
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
            logError(
              `[order] ABORT BEFORE STRIPE: voice persistence failed for ${draftOrder.id}: ${error.message}`,
              error.cause,
            );
            await rollbackUploadedMedia('voice persistence failure');
            return json(
              {
                error:
                  'We could not securely save your voice recording, so we stopped before payment. No charge was made and the recording was not saved — please download it from the checkout page and try again.',
                code: 'voice_persist_failed',
              },
              503,
            );
          }
          logError(`[order] voice upload failed for ${draftOrder.id}; aborting`, error);
          await rollbackUploadedMedia('voice upload failure');
          return json(
            {
              error:
                'We could not securely save your voice recording, so we stopped before payment. No charge was made and the recording was not saved — please download it from the checkout page and try again.',
              code: 'voice_persist_failed',
            },
            503,
          );
        }
      }

      let documentBlobPath: string | null = null;
      let documentBlobUrl: string | null = null;
      let documentConsentAt: string | null = null;
      if (hasDocumentUpload) {
        try {
          await requireActiveLease();
          const uploadedDocument = await deps.uploadOrderDocument(
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
          logError(`[order] ABORT BEFORE STRIPE: document persistence failed for ${draftOrder.id}`, error);
          await rollbackUploadedMedia('document persistence failure');
          return json(
            {
              error: 'We could not securely save your story document, so we stopped before payment. No charge was made. Please try again.',
              code: 'document_persist_failed',
            },
            503,
          );
        }
      }

      // Persist the order record durably. If this throws OrderPersistenceError
      // we MUST NOT create a Stripe Checkout Session — the customer would pay
      // for an order the webhook + status page can never find.
      let order;
      try {
        // Keyed on the DURABLE owner record the entrypoint returned — the same
        // id as the draft, proven so before it returned.
        order = await withOrderTransaction<OrderRecord | null>(persisted.id, (current) => {
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
          logError(
            `[order] ABORT BEFORE STRIPE: durable order persistence failed for ${draftOrder.id}: ${error.message}`,
            error.cause,
          );
          return json(
            {
              error:
                'We could not securely save your order. No charge was made. Please retry in a moment, and contact support@herostorybooks.com if it keeps happening.',
            },
            503,
          );
        }
        throw error;
      }

      deps.markRecoveryLeadConverted(order.email, order.id).catch(() => {});

      // ── The legacy public path uses the SAME provisioning machine ────────
      // It previously created a Session and bound it in one breath, with no
      // durable record in between: a create that succeeded followed by a bind
      // that failed lost the provider identity entirely, leaving retry safety to
      // Stripe's finite idempotency retention. Once that lapsed, an ordinary
      // retry could mint a second payable Session. Same invariant, same code.
      const provisioned = await provisionCheckoutSession({
        order,
        leaseId: draftOrder.checkoutLeaseId!,
        fingerprint: draftOrder.checkoutFingerprint!,
        stripeProductId,
        baseUrl: getReturnBaseUrl(request),
        gaClientId,
      }, legacyCheckoutDeps);

      if (provisioned.status === 'refused') {
        return json(
          { error: provisioned.message, code: provisioned.code },
          provisioned.httpStatus,
        );
      }
      return json({ ok: true, redirectTo: provisioned.url }, 200);
      },
    });
  } catch (error) {
    logError('Order error:', error);
    return json({ error: 'Order submission failed' }, 500);
  }
}
