/**
 * Pure configuration contract for the checkout direct-upload lane.
 *
 * UI/build readiness and the production route shells call this assertion.
 * Runtime guard parsing imports the same numeric parser and defaults, so a
 * configuration cannot be declared ready and then fail only after a request.
 */
import { getBlobNamespace } from './blob-namespace.ts';
import { assertDistinctBlobStores, parseBlobToken } from './checkout-blob-identity.ts';

export const DIRECT_UPLOAD_SERVER_ENV = 'HSB_CHECKOUT_DIRECT_UPLOAD';
export const DIRECT_UPLOAD_CLIENT_ENV = 'NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD';
export const INTAKE_PRIVATE_TOKEN_ENV = 'HSB_INTAKE_BLOB_READ_WRITE_TOKEN';
export const CHECKOUT_GUARD_MODE_ENV = 'HSB_CHECKOUT_GUARD_MODE';
export const CHECKOUT_GUARD_TOKEN_ENV = 'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN';
export const ORDER_PUBLIC_TOKEN_ENV = 'BLOB_READ_WRITE_TOKEN';

export const CHECKOUT_GUARD_LIMIT_DEFAULTS = {
  HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: 12,
  HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE: 24,
  HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: 120 * 1024 * 1024,
  HSB_CHECKOUT_GUARD_MAX_FINALIZATIONS_PER_MINUTE: 12,
  HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE: 32,
  HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: 120,
} as const;

export type CheckoutGuardLimitEnv = keyof typeof CHECKOUT_GUARD_LIMIT_DEFAULTS;

export class DirectUploadConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectUploadConfigurationError';
  }
}

/** Parse one optional limit exactly as runtime will consume it. */
export function parseCheckoutGuardLimit(
  env: NodeJS.ProcessEnv,
  name: CheckoutGuardLimitEnv,
  fallback = CHECKOUT_GUARD_LIMIT_DEFAULTS[name],
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new DirectUploadConfigurationError(`${name} must be a non-negative decimal integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DirectUploadConfigurationError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

/**
 * Assert every environment prerequisite parsed by the real direct-upload
 * route family. This performs no provider I/O and never includes token bytes in
 * an error.
 */
export function assertDirectUploadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env[DIRECT_UPLOAD_SERVER_ENV] !== 'true') {
    throw new DirectUploadConfigurationError(`${DIRECT_UPLOAD_SERVER_ENV} must be true`);
  }
  if (env[CHECKOUT_GUARD_MODE_ENV] !== 'durable') {
    throw new DirectUploadConfigurationError(`${CHECKOUT_GUARD_MODE_ENV} must be durable`);
  }

  const intakeToken = env[INTAKE_PRIVATE_TOKEN_ENV]?.trim() ?? '';
  if (!intakeToken) {
    throw new DirectUploadConfigurationError(`${INTAKE_PRIVATE_TOKEN_ENV} is not set`);
  }
  const guardToken = env[CHECKOUT_GUARD_TOKEN_ENV]?.trim() ?? '';
  if (!guardToken) {
    throw new DirectUploadConfigurationError(`${CHECKOUT_GUARD_TOKEN_ENV} is not set`);
  }

  try {
    parseBlobToken(intakeToken, 'intake');
  } catch {
    throw new DirectUploadConfigurationError(`${INTAKE_PRIVATE_TOKEN_ENV} is invalid`);
  }
  try {
    parseBlobToken(guardToken, 'guard');
  } catch {
    throw new DirectUploadConfigurationError(`${CHECKOUT_GUARD_TOKEN_ENV} is invalid`);
  }
  try {
    assertDistinctBlobStores([
      { label: 'intake', token: intakeToken },
      { label: 'order', token: env[ORDER_PUBLIC_TOKEN_ENV]?.trim() },
      { label: 'guard', token: guardToken },
    ]);
  } catch {
    throw new DirectUploadConfigurationError(
      'Direct upload requires dedicated intake, order, and abuse-guard Blob stores',
    );
  }

  // Both durable stores resolve this namespace before performing I/O.
  try {
    getBlobNamespace(env);
  } catch {
    throw new DirectUploadConfigurationError('HSB_BLOB_NAMESPACE is invalid for direct upload');
  }

  for (const name of Object.keys(CHECKOUT_GUARD_LIMIT_DEFAULTS) as CheckoutGuardLimitEnv[]) {
    parseCheckoutGuardLimit(env, name);
  }
}
