import { createHash } from 'node:crypto';
import { ownsGroupBookInvite, type VerifiedGroupBookPrincipal } from './ownership.ts';

export const GROUP_BOOK_INVITES_ENV = 'GROUP_BOOK_INVITES_JSON';
export const GROUP_BOOK_BLOB_TOKEN_ENV = 'GROUP_BOOK_BLOB_READ_WRITE_TOKEN';

export interface GroupBookInvite {
  token: string;
  cohortId: string;
  familySlotId: string;
  cohortLabel: string;
  /** Server-enforced capability expiry (required). Cookie lifetime is not expiry. */
  expiresAt: string;
  /** Operator revocation; once set the capability grants nothing. */
  revokedAt?: string;
  /** Additive managed identity binding; never inferred from a submitted email. */
  owner?: { issuer: string; subject: string };
}

export type GroupBookInviteState =
  | { state: 'active'; invite: GroupBookInvite }
  | { state: 'expired'; invite: GroupBookInvite }
  | { state: 'revoked'; invite: GroupBookInvite }
  | { state: 'unknown' };

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function isWellFormedGroupBookToken(value: unknown): boolean {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * Only a bare pasted token is accepted. Invites are never distributed or
 * recognized as URLs, so a token cannot leak through history, referrers,
 * logs or analytics page paths.
 */
export function extractGroupBookToken(value: string): string | null {
  const trimmed = value.trim();
  return isWellFormedGroupBookToken(trimmed) ? trimmed : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseInvite(value: unknown): GroupBookInvite | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.token !== 'string' || !isWellFormedGroupBookToken(row.token)) return null;
  if (typeof row.cohortId !== 'string' || !ID_RE.test(row.cohortId)) return null;
  if (typeof row.familySlotId !== 'string' || !ID_RE.test(row.familySlotId)) return null;
  if (typeof row.cohortLabel !== 'string') return null;
  const cohortLabel = row.cohortLabel.trim();
  if (!cohortLabel || cohortLabel.length > 100) return null;
  if (!isTimestamp(row.expiresAt)) return null;
  if (row.revokedAt !== undefined && !isTimestamp(row.revokedAt)) return null;
  let owner: GroupBookInvite['owner'];
  if ('owner' in row) {
    if (!row.owner || typeof row.owner !== 'object' || Array.isArray(row.owner)) return null;
    const binding = row.owner as Record<string, unknown>;
    if (typeof binding.issuer !== 'string' || typeof binding.subject !== 'string') return null;
    if (!/^https:\/\/[^\s?#]+$/.test(binding.issuer) || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.subject)) return null;
    owner = { issuer: binding.issuer, subject: binding.subject };
  }
  return {
    token: row.token,
    cohortId: row.cohortId,
    familySlotId: row.familySlotId,
    cohortLabel,
    expiresAt: row.expiresAt,
    ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt as string } : {}),
    ...(owner ? { owner } : {}),
  };
}

export function groupBookInvites(
  raw: string | undefined = process.env[GROUP_BOOK_INVITES_ENV],
): GroupBookInvite[] {
  if (!raw?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const parsed = decoded.map(parseInvite);
  if (parsed.some((row) => row === null)) return [];
  const invites = parsed as GroupBookInvite[];
  const tokens = new Set<string>();
  const slots = new Set<string>();
  for (const invite of invites) {
    const slot = `${invite.cohortId}\0${invite.familySlotId}`;
    if (tokens.has(invite.token) || slots.has(slot)) return [];
    tokens.add(invite.token);
    slots.add(slot);
  }
  return invites;
}

export function resolveGroupBookInviteState(token: string, now = Date.now(), principal: VerifiedGroupBookPrincipal | null = null): GroupBookInviteState {
  if (!isWellFormedGroupBookToken(token)) return { state: 'unknown' };
  const invite = groupBookInvites().find((row) => row.token === token);
  if (!invite) return { state: 'unknown' };
  // All existing callers fail closed for bound records until they supply a
  // provider-verified principal. A classroom selector is never authentication.
  if (!ownsGroupBookInvite(invite, principal)) return { state: 'unknown' };
  if (invite.revokedAt !== undefined && Date.parse(invite.revokedAt) <= now) return { state: 'revoked', invite };
  if (Date.parse(invite.expiresAt) <= now) return { state: 'expired', invite };
  return { state: 'active', invite };
}

/** Only an active (configured, unexpired, unrevoked) capability resolves. */
export function resolveGroupBookInvite(token: string): GroupBookInvite | null {
  const resolved = resolveGroupBookInviteState(token);
  return resolved.state === 'active' ? resolved.invite : null;
}

/** Typed refusal for a capability that does not resolve to an active invite. */
export function inviteRefusal(state: GroupBookInviteState['state']): 'invalid_invite' | 'invite_expired' | 'invite_revoked' {
  return state === 'expired' ? 'invite_expired' : state === 'revoked' ? 'invite_revoked' : 'invalid_invite';
}

/** Opaque stable key used only inside the dedicated private store. */
export function familyStorageKey(invite: Pick<GroupBookInvite, 'cohortId' | 'familySlotId'>): string {
  return createHash('sha256')
    .update(invite.cohortId, 'utf8')
    .update('\0', 'utf8')
    .update(invite.familySlotId, 'utf8')
    .digest('hex');
}

function blobStoreId(token: string | undefined): string | null {
  if (!token) return null;
  const match = token.trim().match(/^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/);
  return match ? match[1] : null;
}

export function groupBookBlobTokenProblem(
  raw: string | undefined = process.env[GROUP_BOOK_BLOB_TOKEN_ENV],
): string | null {
  const groupStore = blobStoreId(raw);
  if (!raw?.trim()) return `${GROUP_BOOK_BLOB_TOKEN_ENV} is not set`;
  if (!groupStore) return `${GROUP_BOOK_BLOB_TOKEN_ENV} is not a well-formed Blob token`;
  for (const otherEnv of ['BLOB_READ_WRITE_TOKEN', 'FAMILY_REVIEW_DEST_BLOB_TOKEN']) {
    const otherStore = blobStoreId(process.env[otherEnv]);
    if (otherStore && otherStore === groupStore) {
      return `${GROUP_BOOK_BLOB_TOKEN_ENV} must name a different Blob store than ${otherEnv}`;
    }
  }
  return null;
}

export function groupBookBlobToken(): string | null {
  const raw = process.env[GROUP_BOOK_BLOB_TOKEN_ENV];
  return groupBookBlobTokenProblem(raw) === null ? raw!.trim() : null;
}
