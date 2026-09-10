/**
 * Feature flags for the direct private-upload checkout path.
 *
 * Both default OFF. With the server flag off the intake routes answer 404 —
 * not 503, not an empty success — so nothing about the endpoint's existence
 * leaks and no half-enabled state is reachable. With the client flag off the
 * checkout form keeps posting media on the order request exactly as it does
 * today.
 *
 * They are separate on purpose: the server side has to be live and verified in
 * an environment BEFORE any browser in it starts uploading directly, and
 * turning the client flag off has to be enough to stop new direct uploads
 * without tearing down the server that is still reconciling in-flight ones.
 */
import { storyMediaPrivateTokenProblem } from './story-media-store.ts';

export function isDirectUploadServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HSB_CHECKOUT_DIRECT_UPLOAD === 'true';
}

export function isDirectUploadClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD === 'true';
}

/**
 * Whether checkout may show the record-audio, upload-audio and upload-document
 * controls.
 *
 * The capability is the DEDICATED private story-media store and nothing else.
 * It deliberately does not consult `HSB_BLOB_ACCESS_MODE`: that global governs
 * order JSON and hero photos, Production cannot set it to `private` without
 * breaking them, and gating on it is what made these controls disappear. See
 * `./story-media-store.ts`.
 */
export function isCheckoutStoryMediaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const privateBlobReady = storyMediaPrivateTokenProblem(env) === null;
  const hermeticBrowserQa = env.HSB_E2E_STORY_MEDIA_ENABLED === 'true'
    && env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'false'
    && env.HSB_ORDER_STORE_DIR?.endsWith('/.e2e-store') === true;
  return privateBlobReady || hermeticBrowserQa;
}
