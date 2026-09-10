/**
 * The Custom Story media lane's OWN Blob store credential.
 *
 * Why this module exists
 * ----------------------
 * Customer voice notes and story documents must be stored privately. The
 * previous implementation expressed that as a GLOBAL switch —
 * `HSB_BLOB_ACCESS_MODE=private` — which also governs order JSON and hero
 * photos.
 *
 * Production can never set it. A Vercel Blob store is created public or
 * private and cannot be flipped, and the legacy order store named by
 * `BLOB_READ_WRITE_TOKEN` is a PUBLIC store: an `access: 'private'` write
 * against it fails with "Cannot use private access on a public store". Setting
 * the global to satisfy the story-media lane would therefore break order and
 * photo persistence outright.
 *
 * So the variable stayed absent, the gate that required it evaluated false,
 * and the record-audio, upload-audio and upload-document controls silently
 * disappeared from checkout.
 *
 * The fix is the same shape the Family Review lane already uses
 * (`src/lib/family-review/blob-credentials.ts`) and the incident scan already
 * uses (`src/lib/stranded-order-detector-runtime.ts`): the private lane
 * addresses a SEPARATE store with an EXPLICIT token of its own, and every
 * other lane keeps using the ambient one, untouched. Nothing global changes.
 *
 * Which variable
 * --------------
 * Legacy multipart checkout uses `HSB_PRIVATE_READ_WRITE_TOKEN`, already
 * provisioned for a private store. If the browser direct-upload flag is on,
 * the UI and build contract instead validate the direct-intake server flag and
 * `HSB_INTAKE_BLOB_READ_WRITE_TOKEN`, matching the route that receives bytes.
 *
 * Fail closed
 * -----------
 * A missing, blank, or store-colliding credential is a hard stop BEFORE any
 * SDK call. There is no fallback to the ambient token: falling back is exactly
 * how consented child audio would end up in a public store.
 *
 * No value ever leaves this module. Callers receive the token to hand straight
 * to the SDK, or a problem STRING that names the variable and the fault and
 * never quotes the value — a credential that fails validation is the one most
 * likely to be pasted into an incident channel.
 */

import { assertDistinctBlobStores, parseBlobToken } from './checkout-blob-identity.ts';
import {
  assertDirectUploadConfiguration,
  DIRECT_UPLOAD_CLIENT_ENV,
  DIRECT_UPLOAD_SERVER_ENV,
  INTAKE_PRIVATE_TOKEN_ENV,
  ORDER_PUBLIC_TOKEN_ENV,
} from './checkout-direct-config.ts';

export {
  DIRECT_UPLOAD_CLIENT_ENV,
  DIRECT_UPLOAD_SERVER_ENV,
  INTAKE_PRIVATE_TOKEN_ENV,
  ORDER_PUBLIC_TOKEN_ENV,
} from './checkout-direct-config.ts';

/** The single environment variable that names the private story-media store. */
export const STORY_MEDIA_PRIVATE_TOKEN_ENV = 'HSB_PRIVATE_READ_WRITE_TOKEN';


/**
 * What is wrong with the private story-media credential, or null when it is
 * usable. Credential shape and store identity use the same parser as the
 * direct-intake route. Error strings never contain token bytes.
 */
export function storyMediaPrivateTokenProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const privateToken = env[STORY_MEDIA_PRIVATE_TOKEN_ENV]?.trim() ?? '';
  if (!privateToken) return `${STORY_MEDIA_PRIVATE_TOKEN_ENV} is not set`;

  let privateStoreId: string;
  try {
    privateStoreId = parseBlobToken(privateToken, 'story-media').storeId;
  } catch {
    return `${STORY_MEDIA_PRIVATE_TOKEN_ENV} must be a valid Vercel Blob credential`;
  }

  const publicToken = env[ORDER_PUBLIC_TOKEN_ENV]?.trim() ?? '';
  if (!publicToken) return null;

  let publicStoreId: string;
  try {
    publicStoreId = parseBlobToken(publicToken, 'order').storeId;
  } catch {
    return `${ORDER_PUBLIC_TOKEN_ENV} must be a valid Vercel Blob credential`;
  }

  return privateStoreId === publicStoreId
    ? `${STORY_MEDIA_PRIVATE_TOKEN_ENV} must name a different Blob store than ${ORDER_PUBLIC_TOKEN_ENV}`
    : null;
}

/**
 * The private lane's token, or null when it is missing or collides.
 *
 * Null is a STOP, never a signal to try something else. Every caller turns it
 * into a refusal — a hidden control, or an `OrderPersistenceError` that aborts
 * checkout BEFORE Stripe — without touching the public store.
 */
export function storyMediaPrivateToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (storyMediaPrivateTokenProblem(env) !== null) return null;
  return (env[STORY_MEDIA_PRIVATE_TOKEN_ENV] as string).trim();
}

/**
 * Validate the media lane the browser will actually use.
 *
 * When the public client flag is on, checkout sends selected media through the
 * direct-intake routes. That requires the matching server flag and the
 * dedicated intake credential. Otherwise voice/documents stay on the legacy
 * multipart route and require the legacy story-media credential.
 */
export function checkoutStoryMediaConfigurationProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env[DIRECT_UPLOAD_CLIENT_ENV] !== 'true') {
    return storyMediaPrivateTokenProblem(env);
  }

  try {
    assertDirectUploadConfiguration(env);
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Direct upload configuration is invalid';
  }

  return null;
}

/**
 * Which Blob store an object under `orders/<id>/[checkout-<lease>/]` belongs
 * to, or null when this module cannot say.
 *
 * Rollback has to delete each object through the credential for ITS store, and
 * a wrong guess either fails or — far worse — routes a caller-supplied path at
 * a store of the caller's choosing. So classification is a closed allowlist of
 * the exact names the uploaders in `orders.ts` produce, matched against ONE
 * path segment. Anything else is null, and null is refused by the caller.
 *
 * `name` is the single segment AFTER the order/lease prefix. A value
 * containing a separator is unclassifiable by construction, which is also what
 * keeps dot-segments out.
 */
export type OrderMediaLane = 'public' | 'private';

const PUBLIC_MEDIA_NAMES = [
  /^photo-[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^supporting-\d+-photo-[A-Za-z0-9][A-Za-z0-9._-]*$/,
] as const;

const PRIVATE_MEDIA_NAMES = [
  /^voice-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/,
  /^document-[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/,
] as const;

export function classifyOrderMediaLane(name: string): OrderMediaLane | null {
  if (!name || name.includes('/')) return null;
  if (PRIVATE_MEDIA_NAMES.some((pattern) => pattern.test(name))) return 'private';
  if (PUBLIC_MEDIA_NAMES.some((pattern) => pattern.test(name))) return 'public';
  return null;
}

/**
 * True only for a build running on Vercel for the PRODUCTION environment.
 *
 * Vercel sets `VERCEL=1` on every build and deployment and `VERCEL_ENV` to one
 * of `production` | `preview` | `development`. Both are required: CI blanks
 * them (`.github/workflows/ci.yml`), a local `next build` has neither, and a
 * Preview build has `VERCEL_ENV=preview`. None of those may need a secret to
 * build.
 */
export function isVercelProductionBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production';
}

/**
 * The escape hatch, and the only one. An operator who deliberately ships
 * Production without the Custom Story media lane sets this to the exact
 * literal; anything else — including a typo, and including "enabled" — leaves
 * the contract armed.
 */
export const STORY_MEDIA_INTENT_ENV = 'HSB_STORY_MEDIA_INTENT';
const STORY_MEDIA_DISABLED = 'disabled';

export function isStoryMediaExplicitlyDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[STORY_MEDIA_INTENT_ENV] === STORY_MEDIA_DISABLED;
}

/**
 * The deploy-time contract that makes this regression un-shippable.
 *
 * The failure being prevented is silent: an environment variable that the code
 * required and Production did not have, discovered only when a customer could
 * not find the controls. A runtime gate cannot catch that — it is what
 * produced it. So a Vercel PRODUCTION build fails, loudly and before deploy,
 * unless the private story-media credential is usable.
 *
 * Returns a message safe to print, or null when the build may proceed.
 */
export function storyMediaBuildContractProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isVercelProductionBuild(env)) return null;
  if (isStoryMediaExplicitlyDisabled(env)) return null;
  return checkoutStoryMediaConfigurationProblem(env);
}
