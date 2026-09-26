/**
 * Operator preflight probe for the private confirmation-envelope store.
 *
 * ── THIS SCRIPT WRITES TO A REAL VERCEL BLOB STORE. ─────────────────────────
 * It is an explicit, owner-authorized operator action, not part of any build,
 * test, deploy, request or cron path. It is deliberately quarantined: it runs
 * only when invoked directly as the entry module, so importing this file —
 * which is what the guard tests do — performs no I/O at all.
 *
 * As of the A3-2 candidate this probe has NOT been executed. Nothing in the
 * programme may treat the envelope store as proven private until it has.
 *
 * Why it exists
 * -------------
 * `@vercel/blob@2.3.3` reports no store access mode anywhere: `PutBlobResult`
 * and `HeadBlobResult` carry no `access` field. So "a token is configured" is
 * evidence of nothing, and neither is a successful `head`.
 *
 * The store module's always-on Tier 1 evidence — a private write that a PUBLIC
 * store would reject — proves the store is private-CAPABLE. It does not prove
 * that an unauthenticated reader cannot fetch what was written. Only one arm
 * falsifies that, and it is the fourth one below: an unauthenticated fetch of
 * the URL the store itself just returned, which must NOT come back 200.
 *
 * The arms
 * --------
 *   1. dedicated_store             credential parses; its STORE ID differs
 *                                  from every configured HSB lane
 *   2. namespace_resolved          the Blob namespace resolves
 *   3. private_write               `access: 'private'` is accepted
 *   4. authenticated_read          status 200 with readable bytes
 *   5. unauthenticated_fetch_denied  no-credential fetch is NOT 200
 *   6. cleanup_delete              the probe object is deleted
 *   7. cleanup_verified            a typed BlobNotFoundError PROVES it is gone
 *
 * Every arm must pass. Cleanup is attempted in `finally`, and a cleanup
 * failure is still a failure: a probe object left behind in a store nobody
 * enumerates is an object nobody will find again.
 *
 * Arm 7 certifies absence only from the SDK's `BlobNotFoundError`. An expired
 * token, a rate limit, a service outage, a suspended or deleted store, an abort,
 * a timeout or a dropped socket all leave the object's existence UNKNOWN, and
 * this arm refuses to convert unknown into gone. See `isProvenObjectAbsence`.
 *
 * Hard stop: if `unauthenticated_fetch_denied` fails, the store is NOT private
 * and no envelope may ever be written to it. Do not arm the writer. Do not
 * "retry with a different token". Provision a private store.
 *
 * What it prints
 * --------------
 * Fixed arm names and PASS/FAIL, nothing else. No token, no URL, no body, no
 * SDK message, no stack, no store id. The probe body is `{"probe":1}` and
 * contains no customer bytes, no order identifier and no PII.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { BlobNotFoundError, del, get, head, put } from '@vercel/blob';

import { applyBlobNamespace } from '../src/lib/blob-namespace.ts';
import {
  CONFIRMATION_ENVELOPE_PATH_PREFIX,
  CONFIRMATION_ENVELOPE_READ_OPTIONS,
  CONFIRMATION_ENVELOPE_WRITE_OPTIONS,
  resolveConfirmationEnvelopeStoreCredential,
} from '../src/lib/confirmation-envelope-config.ts';

/** The exact arm names this probe may print. Nothing else is ever printed. */
export const PROBE_ARMS = [
  'dedicated_store',
  'namespace_resolved',
  'private_write',
  'authenticated_read',
  'unauthenticated_fetch_denied',
  'cleanup_delete',
  'cleanup_verified',
] as const;

export type ProbeArm = (typeof PROBE_ARMS)[number];

/** Non-identifying bytes. No customer content, no order id, no PII. */
export const PROBE_BODY = '{"probe":1}';

export interface ProbeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly put?: typeof put;
  readonly get?: typeof get;
  readonly del?: typeof del;
  readonly head?: typeof head;
  /** The UNAUTHENTICATED fetch. Never given a token, by construction. */
  readonly fetch?: (url: string) => Promise<{ status: number }>;
  readonly randomId?: () => string;
  readonly log?: (line: string) => void;
}

export interface ProbeResult {
  readonly passed: boolean;
  /** Arm names in the order they were decided. Never anything else. */
  readonly arms: ReadonlyArray<{ readonly arm: ProbeArm; readonly passed: boolean }>;
}

/**
 * Did this thrown value PROVE the object is gone?
 *
 * The production boundary imports `head` and `BlobNotFoundError` from the same
 * `@vercel/blob` module graph. Only that SDK identity proves absence. Provider
 * prose, `.name`, constructor names, and foreign same-named classes are all
 * untrusted ambiguity and must fail closed. A future injected provider boundary
 * must supply its own trusted classifier rather than widening this predicate.
 */
export function isProvenObjectAbsence(error: unknown): boolean {
  try {
    return error instanceof BlobNotFoundError;
  } catch {
    return false;
  }
}

/** The probe object's key. Under the lane's own prefix, below `_probe/`. */
export function confirmationEnvelopeProbePath(namespace: string, id: string): string {
  return applyBlobNamespace(
    `${CONFIRMATION_ENVELOPE_PATH_PREFIX}/_probe/${id}.json`,
    namespace,
  );
}

/**
 * Run every arm. Returns the verdict; never throws, never prints anything but
 * arm names, and never returns a URL, a token, a store id or any SDK value.
 */
export async function runConfirmationEnvelopeStoreProbe(
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const env = deps.env ?? process.env;
  const putImpl = deps.put ?? put;
  const getImpl = deps.get ?? get;
  const delImpl = deps.del ?? del;
  const headImpl = deps.head ?? head;
  const fetchImpl = deps.fetch ?? ((url: string) => fetch(url, { redirect: 'manual' }));
  const randomId = deps.randomId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.log(line));

  const arms: Array<{ arm: ProbeArm; passed: boolean }> = [];
  const record = (arm: ProbeArm, passed: boolean): boolean => {
    arms.push({ arm, passed });
    log(`[confirmation-envelope-probe] ${passed ? 'PASS' : 'FAIL'} ${arm}`);
    return passed;
  };

  // Arms 1 and 2. The resolver checks credential shape, store-id distinctness
  // from every configured HSB lane, and the namespace, and it returns a closed
  // refusal member rather than anything that quotes a value.
  const resolved = resolveConfirmationEnvelopeStoreCredential(env);
  if (resolved.ok === false) {
    const namespaceFault = resolved.refusal === 'namespace_invalid';
    record('dedicated_store', namespaceFault);
    record('namespace_resolved', false);
    return { passed: false, arms };
  }
  record('dedicated_store', true);
  record('namespace_resolved', true);

  const { token, namespace } = resolved.credential;
  const objectPath = confirmationEnvelopeProbePath(namespace, randomId());

  let written = false;
  let probeUrl: string | null = null;
  try {
    // Arm 3. A PUBLIC store rejects this call. There is no fallback and no
    // retry: a probe that retried publicly would prove the opposite of what it
    // is for.
    try {
      const result = await putImpl(objectPath, PROBE_BODY, {
        ...CONFIRMATION_ENVELOPE_WRITE_OPTIONS,
        token,
      });
      written = true;
      // The URL is used by arm 5 and by nothing else. It is never printed,
      // returned, logged or persisted.
      probeUrl = typeof result?.url === 'string' ? result.url : null;
      record('private_write', true);
    } catch {
      record('private_write', false);
      return { passed: false, arms };
    }

    // Arm 4, the positive control: an authenticated read must return 200 with
    // readable bytes that are the bytes we wrote.
    try {
      const result = await getImpl(objectPath, { ...CONFIRMATION_ENVELOPE_READ_OPTIONS, token });
      const ok =
        !!result &&
        result.statusCode === 200 &&
        !!result.stream &&
        (await new Response(result.stream).text()) === PROBE_BODY;
      if (!record('authenticated_read', ok)) return { passed: false, arms };
    } catch {
      record('authenticated_read', false);
      return { passed: false, arms };
    }

    // Arm 5, the decisive negative control. If this returns 200 the store is
    // public and the programme stops here.
    if (!probeUrl) {
      // No URL means the arm cannot be evaluated, and an arm that cannot be
      // evaluated has not passed.
      record('unauthenticated_fetch_denied', false);
      return { passed: false, arms };
    }
    try {
      const response = await fetchImpl(probeUrl);
      if (!record('unauthenticated_fetch_denied', response.status !== 200)) {
        return { passed: false, arms };
      }
    } catch {
      // A transport failure is not evidence that the object is protected.
      record('unauthenticated_fetch_denied', false);
      return { passed: false, arms };
    }
  } finally {
    // Arms 6 and 7. Attempted whatever happened above; a cleanup failure is
    // still a failure of the probe as a whole.
    if (written) {
      let deleted = false;
      try {
        await delImpl(objectPath, { token });
        deleted = true;
      } catch {
        deleted = false;
      }
      record('cleanup_delete', deleted);

      let verified = false;
      try {
        await headImpl(objectPath, { token });
        // The object answered a HEAD: it is still there, so cleanup did not take.
        verified = false;
      } catch (error) {
        // ONLY a proven absence counts. Every other failure leaves the object's
        // existence unknown, and unknown is not cleanup — so the arm stays
        // false and the probe as a whole fails.
        verified = isProvenObjectAbsence(error);
      }
      record('cleanup_verified', verified);
    }
  }

  return { passed: arms.every((entry) => entry.passed), arms };
}

/**
 * Entry point. Runs ONLY when this file is the process entry module, so an
 * import — a guard test, a bundler graph walk, a type check — performs no I/O.
 */
async function main(): Promise<void> {
  const result = await runConfirmationEnvelopeStoreProbe();
  console.log(
    `[confirmation-envelope-probe] ${result.passed ? 'PASS' : 'FAIL'} overall`,
  );
  process.exit(result.passed ? 0 : 1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
