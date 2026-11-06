import { groupBookInvitesStrict } from './config.ts';
import { classroomCodesStrict } from './identity-access.ts';
import type { ClassroomTrustedInput } from './order-handler.ts';

/**
 * Server-owned trusted input for authenticated classroom order creation.
 *
 * Provenance: the single server runtime variable HSB_CLASSROOM_ORDER_INPUT_JSON,
 * set by an operator on the host. It is never NEXT_PUBLIC_, never derived from
 * a request (URL, query, headers or body) and has no default: unset, disabled
 * or invalid configuration supplies nothing and the order route answers 503.
 * Provisioning this variable on any real host is a separate, future approved
 * gate; this module ships no cohort, format or contact value.
 *
 * Strict versioned allowlist (exact keys everywhere, no extras):
 *   {"schemaVersion":1,"enabled":true,"selectedCohortId":"<id>",
 *    "targets":[{"cohortId":"<id>","bookFormat":"digital|classic|premium","contactEmail":"<email>"}]}
 * The explicitly selected cohort must match exactly one target AND be a
 * currently active cohort in the existing strict registries (legacy invites
 * or classroom selectors); a malformed registry qualifies nothing.
 *
 * Every value is read per invocation (never at import). Any parse or runtime
 * failure yields null; the order handler remains the outer exception guard.
 */
export const CLASSROOM_ORDER_INPUT_ENV = 'HSB_CLASSROOM_ORDER_INPUT_JSON';

/** Bounds on operator configuration; exceeding either supplies nothing. */
export const CLASSROOM_ORDER_INPUT_MAX_CHARS = 16_384;
export const CLASSROOM_ORDER_INPUT_MAX_TARGETS = 100;

const TOP_KEYS = ['enabled', 'schemaVersion', 'selectedCohortId', 'targets'];
const TARGET_KEYS = ['bookFormat', 'cohortId', 'contactEmail'];
const COHORT_RE = /^[A-Za-z0-9_-]{3,64}$/;
const FORMATS: ReadonlySet<string> = new Set(['digital', 'classic', 'premium']);
const EMAIL_LOCAL_RE = /^[A-Za-z0-9._%+-]{1,64}$/;
const EMAIL_DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isContactEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return EMAIL_LOCAL_RE.test(local) && domain.length <= 190 && EMAIL_DOMAIN_RE.test(domain);
}

function parseTarget(value: unknown): ClassroomTrustedInput | null {
  if (!exactKeys(value, TARGET_KEYS)) return null;
  const { cohortId, bookFormat, contactEmail } = value;
  if (typeof cohortId !== 'string' || !COHORT_RE.test(cohortId)) return null;
  if (typeof bookFormat !== 'string' || !FORMATS.has(bookFormat)) return null;
  if (!isContactEmail(contactEmail)) return null;
  return { cohortId, bookFormat: bookFormat as ClassroomTrustedInput['bookFormat'], contactEmail };
}

/** Strict parse of the raw configuration string; null for absent, disabled or invalid. */
export function parseClassroomOrderInput(raw: string | undefined): ClassroomTrustedInput | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > CLASSROOM_ORDER_INPUT_MAX_CHARS) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!exactKeys(decoded, TOP_KEYS)) return null;
  if (decoded.schemaVersion !== 1 || decoded.enabled !== true) return null;
  const { selectedCohortId, targets } = decoded;
  if (typeof selectedCohortId !== 'string' || !COHORT_RE.test(selectedCohortId)) return null;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > CLASSROOM_ORDER_INPUT_MAX_TARGETS) return null;
  const parsed: ClassroomTrustedInput[] = [];
  const cohorts = new Set<string>();
  for (const row of targets) {
    const target = parseTarget(row);
    if (!target || cohorts.has(target.cohortId)) return null;
    cohorts.add(target.cohortId);
    parsed.push(target);
  }
  return parsed.find((target) => target.cohortId === selectedCohortId) ?? null;
}

const active = (row: { expiresAt: string; revokedAt?: string }, now: number) =>
  Date.parse(row.expiresAt) > now && (row.revokedAt === undefined || Date.parse(row.revokedAt) > now);

/** The cohort is currently active in the existing strict registries; any malformed registry qualifies nothing. */
export function isQualifiedClassroomCohort(cohortId: string, now = Date.now()): boolean {
  const legacy = groupBookInvitesStrict();
  const selectors = classroomCodesStrict();
  if (legacy.state === 'malformed' || selectors.state === 'malformed') return false;
  const invites = legacy.state === 'valid' ? legacy.invites : [];
  const cohorts = selectors.state === 'valid' ? selectors.cohorts : [];
  return invites.some((row) => row.cohortId === cohortId && active(row, now))
    || cohorts.some((row) => row.cohortId === cohortId && active(row, now));
}

/** Trusted input supplier for the mounted route; called only after admin authentication. */
export async function classroomTrustedInputFromEnv(): Promise<ClassroomTrustedInput | null> {
  try {
    const input = parseClassroomOrderInput(process.env[CLASSROOM_ORDER_INPUT_ENV]);
    if (!input || !isQualifiedClassroomCohort(input.cohortId)) return null;
    return input;
  } catch {
    return null;
  }
}
