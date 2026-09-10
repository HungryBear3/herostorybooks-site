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
import {
  checkoutStoryMediaConfigurationProblem,
  isStoryMediaExplicitlyDisabled,
} from './story-media-store.ts';

export function isDirectUploadServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HSB_CHECKOUT_DIRECT_UPLOAD === 'true';
}

/** Whether a new browser session may use the direct-upload transport. */
export function isCheckoutDirectUploadEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isStoryMediaExplicitlyDisabled(env)) return false;
  if (env.NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD !== 'true') return false;
  return checkoutStoryMediaConfigurationProblem(env) === null;
}

/**
 * Whether checkout may show the record-audio, upload-audio and upload-document
 * controls.
 *
 * Capability follows the browser-selected path: the direct-intake store when
 * the public direct-upload flag is on, otherwise the dedicated legacy
 * story-media store. Neither path consults `HSB_BLOB_ACCESS_MODE`: that global
 * governs order JSON and hero photos, and gating on it caused the regression.
 */
export function isCheckoutStoryMediaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isStoryMediaExplicitlyDisabled(env)) return false;

  const selectedUploadPathReady = checkoutStoryMediaConfigurationProblem(env) === null;
  const hermeticBrowserQa = env.NODE_ENV !== 'production'
    && env.HSB_E2E_STORY_MEDIA_ENABLED === 'true'
    && env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'false'
    && env.HSB_ORDER_STORE_DIR?.endsWith('/.e2e-store') === true
    && env.NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD !== 'true';
  return selectedUploadPathReady || hermeticBrowserQa;
}
