import { createHash } from 'node:crypto';

/**
 * Release/admission switch for NEW group-book intake. Default OFF: only the
 * exact string "true" opens admission. Recovery, own-family read and
 * withdrawal of existing work are not gated by this switch.
 */
export const GROUP_BOOK_INTAKE_ENABLED_ENV = 'GROUP_BOOK_INTAKE_ENABLED';

/**
 * The owner-adopted policy is pinned in source, not configuration: it can only
 * change through a reviewed code change. Each submission stamps the version and
 * digest it consented to; editing this record changes its digest and blocks
 * export admission of every submission that consented to the old bytes.
 *
 * Source: owner decision record hsb-classroom-submission-policy-2026-10-19-v1
 * (owner Alexy Kaplun; sha256 of the decision file below). Each text begins
 * with the owner's exact answer, followed by that record's adopted specifics.
 */
const ADOPTED_POLICIES: readonly GroupBookPolicyAdoption[] = [
  {
    version: 'hsb-classroom-submission-policy-2026-10-19-v1',
    adoptedAt: '2026-10-19',
    adoptedBy: 'Alexy Kaplun',
    sourceSha256: '57cedae1e7db65cd796d5b992c93a3a911cdf15e22d6c08c91b9a354b4849a21',
    finishedBookRecipients:
      'Participating families and approved teachers only. There is no public gallery, and no school endorsement is implied.',
    guardianReviewScope: 'Each parent or guardian approves the portrayal of their own child only.',
    depictedAdultPermission: 'Any adult shown in a submitted photo must consent before it is used.',
    wholeBookApproval: 'Alexy Kaplun gives the final release of the whole book.',
    withdrawalCutoff:
      'Until final release to printing or distribution, whichever comes first. Before that release, a withdrawn child is omitted from the edition, including work in progress before publication. Withdrawal does not delete anything immediately: your submission summary and source photos are kept until the ordinary retention period ends. Viewing them requires valid authorization; if your family invite expires or is revoked, access ends until the operator reissues a new invite. Copies already released are not recalled.',
    sourcePhotoRetention:
      '90 days, then delete source photos. The 90 days start at the authoritatively recorded final delivery of the book, not at upload, preview, payment or print submission. This covers source-photo objects and controlled source-photo copies that Hero Story Books holds privately for this group book. The finished book and necessary transaction records are kept separately. Deletion from storage-provider backups is not promised. Until a final delivery is recorded, no deletion date exists.',
  },
];

export const GROUP_BOOK_POLICY_TEXT_FIELDS = [
  'finishedBookRecipients',
  'withdrawalCutoff',
  'sourcePhotoRetention',
  'depictedAdultPermission',
  'guardianReviewScope',
  'wholeBookApproval',
] as const;

type PolicyTextField = (typeof GROUP_BOOK_POLICY_TEXT_FIELDS)[number];

export type GroupBookPolicyAdoption = {
  version: string;
  adoptedAt: string;
  adoptedBy: string;
  sourceSha256: string;
} & Record<PolicyTextField, string>;

export interface AdoptedGroupBookPolicy {
  record: GroupBookPolicyAdoption;
  digest: string;
}

export type GroupBookPolicyState =
  | { state: 'adopted'; current: AdoptedGroupBookPolicy; byVersion: Map<string, AdoptedGroupBookPolicy> }
  | { state: 'missing' }
  | { state: 'malformed' };

export type GroupBookAdmission =
  | { open: true; policy: AdoptedGroupBookPolicy }
  | { open: false; refusal: 'intake_closed' | 'policy_not_adopted' };

const KEYS = new Set<string>(['version', 'adoptedAt', 'adoptedBy', 'sourceSha256', ...GROUP_BOOK_POLICY_TEXT_FIELDS]);

export function groupBookIntakeEnabled(raw: string | undefined = process.env[GROUP_BOOK_INTAKE_ENABLED_ENV]): boolean {
  return raw === 'true';
}

function isOwnerText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function parseAdoption(value: unknown): GroupBookPolicyAdoption | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !KEYS.has(key))) return null;
  if (!isOwnerText(row.version, 100)) return null;
  if (typeof row.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sourceSha256)) return null;
  if (typeof row.adoptedAt !== 'string' || Number.isNaN(Date.parse(row.adoptedAt))) return null;
  if (!isOwnerText(row.adoptedBy, 200)) return null;
  for (const field of GROUP_BOOK_POLICY_TEXT_FIELDS) {
    if (!isOwnerText(row[field], 4000)) return null;
  }
  return row as unknown as GroupBookPolicyAdoption;
}

/** Digest over a fixed key order, so formatting of the env JSON is irrelevant. */
export function groupBookPolicyDigest(record: GroupBookPolicyAdoption): string {
  const canonical = JSON.stringify([
    record.version,
    record.adoptedAt,
    record.adoptedBy,
    record.sourceSha256,
    ...GROUP_BOOK_POLICY_TEXT_FIELDS.map((field) => record[field]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Validates adoption records; the last record is current. Exported for tests. */
export function parseGroupBookPolicies(records: readonly unknown[]): GroupBookPolicyState {
  if (records.length === 0) return { state: 'missing' };
  const byVersion = new Map<string, AdoptedGroupBookPolicy>();
  let current: AdoptedGroupBookPolicy | null = null;
  for (const value of records) {
    const record = parseAdoption(value);
    if (!record || byVersion.has(record.version)) return { state: 'malformed' };
    current = { record, digest: groupBookPolicyDigest(record) };
    byVersion.set(record.version, current);
  }
  return { state: 'adopted', current: current!, byVersion };
}

export function groupBookPolicyState(): GroupBookPolicyState {
  return parseGroupBookPolicies(ADOPTED_POLICIES);
}

/** Server-side admission decision for NEW persistence. */
export function groupBookAdmission(): GroupBookAdmission {
  if (!groupBookIntakeEnabled()) return { open: false, refusal: 'intake_closed' };
  const policy = groupBookPolicyState();
  if (policy.state !== 'adopted') return { open: false, refusal: 'policy_not_adopted' };
  return { open: true, policy: policy.current };
}

/** The verbatim owner text a parent sees before consenting. */
export function publicPolicyView(policy: AdoptedGroupBookPolicy) {
  const view: Record<string, string> = { version: policy.record.version, digest: policy.digest };
  for (const field of GROUP_BOOK_POLICY_TEXT_FIELDS) view[field] = policy.record[field];
  return view;
}
