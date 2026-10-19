// Synthetic-only admission helper for group-book route tests. The policy is
// the code-pinned owner-adopted record; only the release switch is toggled.
const release = await import('../../src/lib/group-book/release.ts');

const state = release.groupBookPolicyState();
if (state.state !== 'adopted') throw new Error('adopted policy record failed validation');

export const SYNTHETIC_EXPIRES_AT = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

/** Stamp a client would echo after reading the adopted terms. */
export const SYNTHETIC_POLICY_STAMP = { version: state.current.record.version, digest: state.current.digest };

export function openSyntheticAdmission() {
  process.env.GROUP_BOOK_INTAKE_ENABLED = 'true';
}
