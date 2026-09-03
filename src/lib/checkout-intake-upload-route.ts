/**
 * Request handling for `POST /api/checkout/intake/upload`.
 *
 * The route body lives here, separate from the Next.js route file, so the
 * production request path can be driven in tests without a network, a real
 * Blob store, or a deployment. The route file is a shell around
 * `handleIntakeUploadRequest`.
 *
 * THE THING THIS FILE EXISTS TO GET RIGHT
 * ---------------------------------------
 * Two different clients POST here and they authenticate differently:
 *
 *   blob.generate-client-token   the BROWSER asking for an upload token.
 *                                Guarded as a browser mutation (same-origin)
 *                                plus a budget spend.
 *
 *   blob.upload-completed        VERCEL BLOB reporting the upload landed.
 *                                A server-to-server request with an HMAC
 *                                signature and no `Origin` /
 *                                `Sec-Fetch-Site`. `handleUpload` verifies the
 *                                signature; a browser origin check here would
 *                                reject every real callback before it got
 *                                there — which is exactly what the previous
 *                                implementation did.
 *
 * So the event type is decided FIRST, and the browser guard is applied only on
 * the browser branch.
 */
import type { handleUpload as vercelHandleUpload } from '@vercel/blob/client';

import { isDirectUploadServerEnabled } from './checkout-direct-flags.ts';
import { INTAKE_UPLOAD_TOKEN_TTL_MS, IntakeError, type IntakeStore } from './checkout-intake.ts';
import {
  authorizeReservedUpload,
  completeSlotUpload,
} from './checkout-intake-upload.ts';
import {
  assertBrowserMutationRequest,
  enforceCheckoutBudget,
  resolveCallbackRequestLimit,
  type CheckoutGuardStore,
} from './checkout-request-guard.ts';

export { INTAKE_UPLOAD_TOKEN_TTL_MS } from './checkout-intake.ts';

export interface IntakeUploadRouteDeps {
  handleUpload: typeof vercelHandleUpload;
  store: IntakeStore;
  guardStore?: CheckoutGuardStore | null;
  env: NodeJS.ProcessEnv;
  blobToken: string;
  now?: () => Date;
}

/** What the browser sends in `clientPayload` — a pointer, never a request. */
export interface UploadClientPayload {
  intakeId: string;
  capability: string;
  slotKey: string;
  generation: number;
  reservationId: string;
}

const CLIENT_PAYLOAD_MAX_BYTES = 2048;

export function parseUploadClientPayload(raw: unknown): UploadClientPayload {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > CLIENT_PAYLOAD_MAX_BYTES) {
    throw new IntakeError('upload_payload_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IntakeError('upload_payload_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IntakeError('upload_payload_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.intakeId !== 'string'
    || typeof value.capability !== 'string'
    || typeof value.slotKey !== 'string'
    || !value.slotKey
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || typeof value.reservationId !== 'string') {
    throw new IntakeError('upload_payload_invalid');
  }
  return {
    intakeId: value.intakeId,
    capability: value.capability,
    slotKey: value.slotKey,
    generation: value.generation as number,
    reservationId: value.reservationId,
  };
}

function errorResponse(error: unknown): Response {
  const intakeError = error instanceof IntakeError ? error : new IntakeError('upload_request_rejected', 400);
  return Response.json({ error: intakeError.code }, { status: intakeError.status });
}

export async function handleIntakeUploadRequest(
  request: Request,
  deps: IntakeUploadRouteDeps,
): Promise<Response> {
  if (!isDirectUploadServerEnabled(deps.env)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const now = deps.now ?? (() => new Date());

  let body: { type?: unknown; payload?: unknown };
  try {
    body = await request.json() as { type?: unknown; payload?: unknown };
  } catch {
    return errorResponse(new IntakeError('upload_body_invalid'));
  }

  const eventType = body?.type;
  if (eventType !== 'blob.generate-client-token' && eventType !== 'blob.upload-completed') {
    return errorResponse(new IntakeError('upload_event_invalid'));
  }

  try {
    if (eventType === 'blob.generate-client-token') {
      // Browser half only.
      assertBrowserMutationRequest(request);
      // Request count only. The reservation and its bytes were charged when
      // the browser reserved the slot; charging again here would double-count
      // the same upload and make the ceiling arbitrary.
      await enforceCheckoutBudget({
        scope: 'intake-upload',
        env: deps.env,
        store: deps.guardStore,
        now: now().getTime(),
        cost: { requestCount: 1 },
      });
    }
    // NOTE: the callback branch spends NOTHING here. Its budget is consumed
    // inside `onUploadCompleted`, which the SDK reaches only after verifying
    // the HMAC — see the comment on that handler.

    const result = await deps.handleUpload({
      request,
      body: body as Parameters<typeof vercelHandleUpload>[0]['body'],
      token: deps.blobToken,

      async onBeforeGenerateToken(pathname, clientPayload) {
        const payload = parseUploadClientPayload(clientPayload);
        const issuedAt = now();
        const authorization = await authorizeReservedUpload(
          deps.store,
          { ...payload, pathname },
          issuedAt,
        );
        return {
          allowedContentTypes: authorization.allowedContentTypes,
          maximumSizeInBytes: authorization.maximumSizeInBytes,
          // The pathname was chosen by the server at reservation time and is
          // unique to this generation, so there is never anything to suffix
          // and never anything to overwrite.
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: issuedAt.getTime() + INTAKE_UPLOAD_TOKEN_TTL_MS,
          tokenPayload: authorization.tokenPayload,
        };
      },

      async onUploadCompleted({ blob, tokenPayload }) {
        // Reached ONLY after `handleUpload` has verified `x-vercel-signature`
        // against the store token. Spending the callback budget here rather
        // than at branch selection is the whole point: an unsigned or
        // mis-signed request never gets this far, so it cannot exhaust the
        // budget that genuine completions need. It is still spent BEFORE any
        // intake or storage work, so an authenticated caller cannot make this
        // endpoint do unbounded work either.
        await enforceCheckoutBudget({
          scope: 'intake-upload-callback',
          env: deps.env,
          store: deps.guardStore,
          now: now().getTime(),
          requestLimit: resolveCallbackRequestLimit(deps.env),
          cost: { requestCount: 1 },
        });

        // `PutBlobResult` carries no size, and its etag is the provider's word
        // for it. Read the object back and let STORAGE be authoritative for
        // both, so the completion is checked against what is really there.
        const object = await deps.store.headAsset(blob.pathname);
        if (!object) throw new IntakeError('asset_metadata_missing', 409);
        if (object.mimeType !== blob.contentType) throw new IntakeError('asset_metadata_mismatch', 409);
        await completeSlotUpload(
          deps.store,
          {
            tokenPayload,
            blob: {
              pathname: blob.pathname,
              contentType: object.mimeType,
              size: object.size,
              etag: object.etag,
            },
          },
          now(),
        );
      },
    });

    return Response.json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
