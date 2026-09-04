/**
 * Request handling for `POST /api/checkout/intake` — everything the buyer's
 * page does to the intake state machine.
 *
 * One endpoint with an `action`, rather than six routes, because they share
 * one guard, one budget scope and one error shape, and because the set is
 * fixed and small:
 *
 *   create          start an intake, get back its id and capability
 *   consent         widen consent (voice, inspiration document)
 *   reserve-upload  claim the next generation of a slot and learn where to
 *                   upload
 *   resolve-upload  reconcile a slot whose upload response or callback was
 *                   lost
 *   list            what the slots currently hold
 *   release         empty a slot (Remove, or the cancel half of Change)
 *
 * Every action is a browser mutation, so every action gets the same-origin
 * guard — the exact opposite of the upload route, where the provider callback
 * must NOT get it.
 *
 * Two things deliberately never cross this boundary: the callback token
 * payload (server-issued, server-verified — the browser has no use for it) and
 * the stored capability hash or object etags (validators the client cannot
 * check and must not be able to forge a match against).
 */
import { isDirectUploadServerEnabled } from './checkout-direct-flags.ts';
import {
  createIntake,
  INTAKE_CATEGORY_POLICY,
  IntakeError,
  listIntakeSlots,
  refreshIntakeConsent,
  type IntakeConsent,
  type IntakeStore,
  type IntakeVoiceSource,
  type SlotRef,
} from './checkout-intake.ts';
import {
  preflightSlotUploadReservation,
  releaseSlot,
  reserveSlotUpload,
  resolveSlotUpload,
} from './checkout-intake-upload.ts';
import {
  assertBrowserMutationRequest,
  enforceCheckoutBudget,
  refundCheckoutBudget,
  resolveCheckoutGuardStore,
  type CheckoutGuardCost,
  type CheckoutGuardStore,
} from './checkout-request-guard.ts';

export interface IntakeRouteDeps {
  store: IntakeStore;
  guardStore?: CheckoutGuardStore | null;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

type IntakeAction = 'create' | 'consent' | 'reserve-upload' | 'resolve-upload' | 'list' | 'release';

const ACTIONS: readonly IntakeAction[] = ['create', 'consent', 'reserve-upload', 'resolve-upload', 'list', 'release'];

/**
 * What each action costs the global budget.
 *
 * `reserve-upload` is the ONE place upload bytes are charged, and it charges
 * the DECLARED reserved size — the size the client token will authorise —
 * rather than waiting to see what actually lands. A reservation is capacity: it
 * costs whether or not the bytes arrive, so an abandoned reservation is
 * charged like any other. Nothing downstream (token issuance, the completion
 * callback) charges bytes again.
 */
function costForAction(action: IntakeAction, body: Record<string, unknown>): CheckoutGuardCost {
  switch (action) {
    case 'create':
      return { requestCount: 1, intakeCreations: 1 };
    case 'reserve-upload':
      return {
        requestCount: 1,
        uploadReservations: 1,
        replacementCount: 1,
        uploadBytes: readReservedSize(body.size),
      };
    case 'release':
      return { requestCount: 1, replacementCount: 1 };
    default:
      return { requestCount: 1 };
  }
}

/**
 * The declared size, validated before it is charged.
 *
 * Read here as well as in the handler because the budget must be spent on a
 * number we have already bounded — a caller must not be able to make the
 * counter jump by declaring a nonsense size, nor to reserve without being
 * charged by declaring one.
 */
function readReservedSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new IntakeError('asset_size_invalid');
  if ((value as number) > MAX_DECLARABLE_UPLOAD_BYTES) throw new IntakeError('asset_too_large', 413);
  return value as number;
}

/** The largest size any category permits; per-category limits apply later. */
const MAX_DECLARABLE_UPLOAD_BYTES = Math.max(
  ...Object.values(INTAKE_CATEGORY_POLICY).map((policy) => policy.maxBytes),
);

function errorResponse(error: unknown): Response {
  const intakeError = error instanceof IntakeError ? error : new IntakeError('intake_request_rejected', 400);
  return Response.json({ error: intakeError.code }, { status: intakeError.status });
}

function readString(value: unknown, code: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) throw new IntakeError(code);
  return value;
}

function readSlotRef(value: unknown): SlotRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntakeError('asset_category_invalid');
  const raw = value as Record<string, unknown>;
  return {
    category: raw.category as SlotRef['category'],
    familyCharacterId: typeof raw.familyCharacterId === 'string' ? raw.familyCharacterId : null,
    guidedStillIndex: Number.isInteger(raw.guidedStillIndex) ? (raw.guidedStillIndex as number) : null,
  };
}

/**
 * Consent arrives as booleans and is timestamped HERE.
 *
 * A client-supplied `...AuthorizedAt` would be an unverifiable claim about
 * when a person agreed to something, written into the record that is our
 * evidence of that agreement.
 */
function readConsent(value: unknown, now: Date): IntakeConsent {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (raw.mediaAuthorized !== true) throw new IntakeError('media_authorization_required');
  const at = now.toISOString();
  const voiceSource = raw.voiceSource === 'recorded' || raw.voiceSource === 'uploaded'
    ? raw.voiceSource as IntakeVoiceSource
    : null;
  return {
    mediaAuthorizedAt: at,
    documentAuthorizedAt: raw.documentAuthorized === true ? at : null,
    childVoiceAuthorizedAt: raw.childVoiceAuthorized === true ? at : null,
    voiceSource,
  };
}

function readConsentPatch(value: unknown, now: Date): Partial<IntakeConsent> {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const at = now.toISOString();
  return {
    documentAuthorizedAt: raw.documentAuthorized === true ? at : null,
    childVoiceAuthorizedAt: raw.childVoiceAuthorized === true ? at : null,
    voiceSource: raw.voiceSource === 'recorded' || raw.voiceSource === 'uploaded'
      ? raw.voiceSource as IntakeVoiceSource
      : null,
  };
}

export async function handleIntakeRequest(request: Request, deps: IntakeRouteDeps): Promise<Response> {
  if (!isDirectUploadServerEnabled(deps.env)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const now = (deps.now ?? (() => new Date()))();

  try {
    assertBrowserMutationRequest(request);
  } catch (error) {
    return errorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse(new IntakeError('intake_body_invalid'));
  }

  const action = body?.action as IntakeAction;
  if (!ACTIONS.includes(action)) return errorResponse(new IntakeError('intake_action_invalid'));

  try {
    if (action === 'reserve-upload') {
      // Production does not inject a guard store. Resolve it once so failure
      // compensation targets the exact store that accepted the scarce spend.
      const guardStore = deps.guardStore ?? resolveCheckoutGuardStore(deps.env);
      // Count the request first, but do not spend scarce upload capacity until
      // the addressed intake, capability, slot and policy all validate.
      await enforceCheckoutBudget({
        scope: 'intake',
        env: deps.env,
        store: guardStore,
        now: now.getTime(),
        cost: { requestCount: 1 },
      });
      const size = readReservedSize(body.size);
      const input = {
        intakeId: readString(body.intakeId, 'intake_id_invalid'),
        capability: readString(body.capability, 'intake_forbidden'),
        slot: readSlotRef(body.slot),
        mimeType: readString(body.mimeType, 'asset_mime_invalid', 128),
        size,
      };
      await preflightSlotUploadReservation(deps.store, input, now);
      await enforceCheckoutBudget({
        scope: 'intake',
        env: deps.env,
        store: guardStore,
        now: now.getTime(),
        cost: {
          requestCount: 0,
          uploadReservations: 1,
          replacementCount: 1,
          uploadBytes: size,
        },
      });
      let reservation;
      try {
        reservation = await reserveSlotUpload(deps.store, input, now);
      } catch (error) {
        await refundCheckoutBudget(guardStore, {
          scope: 'intake', now: now.getTime(),
          cost: { requestCount: 0, uploadReservations: 1, replacementCount: 1, uploadBytes: size },
        });
        throw error;
      }
      return Response.json({
        slotKey: reservation.slotKey,
        generation: reservation.generation,
        reservationId: reservation.reservationId,
        pathname: reservation.pathname,
        // Echoed so the browser can prove it is uploading the string that was
        // reserved; a disagreement is a contract drift and fails closed there.
        mimeType: reservation.mimeType,
        allowedContentTypes: reservation.allowedContentTypes,
        maximumSizeInBytes: reservation.maximumSizeInBytes,
      }, { status: 200 });
    }

    // Cost is derived from the body BEFORE anything is written, so a refused
    // spend leaves no reservation behind.
    await enforceCheckoutBudget({
      scope: 'intake',
      env: deps.env,
      store: deps.guardStore,
      now: now.getTime(),
      cost: costForAction(action, body),
    });

    switch (action) {
      case 'create': {
        const created = await createIntake(deps.store, readConsent(body.consent, now), now);
        return Response.json(created, { status: 200 });
      }

      case 'consent': {
        const consent = await refreshIntakeConsent(deps.store, {
          intakeId: readString(body.intakeId, 'intake_id_invalid'),
          capability: readString(body.capability, 'intake_forbidden'),
          consent: readConsentPatch(body.consent, now),
        }, now);
        return Response.json({
          documentAuthorized: Boolean(consent.documentAuthorizedAt),
          childVoiceAuthorized: Boolean(consent.childVoiceAuthorizedAt),
          voiceSource: consent.voiceSource ?? null,
        }, { status: 200 });
      }


      case 'resolve-upload': {
        const generation = body.generation;
        if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
          throw new IntakeError('upload_generation_invalid');
        }
        const resolved = await resolveSlotUpload(deps.store, {
          intakeId: readString(body.intakeId, 'intake_id_invalid'),
          capability: readString(body.capability, 'intake_forbidden'),
          slot: readSlotRef(body.slot),
          generation: generation as number,
        }, now);
        return Response.json({
          status: resolved.status,
          asset: resolved.asset
            ? {
              assetId: resolved.asset.assetId,
              slotKey: resolved.asset.slotKey,
              category: resolved.asset.category,
              generation: resolved.asset.generation,
              mimeType: resolved.asset.mimeType,
              size: resolved.asset.size,
            }
            : null,
        }, { status: 200 });
      }

      case 'list': {
        const listed = await listIntakeSlots(deps.store, {
          intakeId: readString(body.intakeId, 'intake_id_invalid'),
          capability: readString(body.capability, 'intake_forbidden'),
        }, now);
        return Response.json({
          expiresAt: listed.expiresAt,
          slots: listed.slots.map((slot) => ({
            slotKey: slot.slotKey,
            category: slot.category,
            familyCharacterId: slot.familyCharacterId,
            guidedStillIndex: slot.guidedStillIndex,
            generation: slot.generation,
            pendingGeneration: slot.pendingGeneration,
            assetId: slot.asset?.assetId ?? null,
            mimeType: slot.asset?.mimeType ?? null,
            size: slot.asset?.size ?? null,
          })),
        }, { status: 200 });
      }

      case 'release': {
        const released = await releaseSlot(deps.store, {
          intakeId: readString(body.intakeId, 'intake_id_invalid'),
          capability: readString(body.capability, 'intake_forbidden'),
          slot: readSlotRef(body.slot),
        }, now);
        return Response.json(released, { status: 200 });
      }

      default:
        return errorResponse(new IntakeError('intake_action_invalid'));
    }
  } catch (error) {
    return errorResponse(error);
  }
}
