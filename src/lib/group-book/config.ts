import { createHash } from 'node:crypto';

export const GROUP_BOOK_INVITES_ENV = 'GROUP_BOOK_INVITES_JSON';
export const GROUP_BOOK_BLOB_TOKEN_ENV = 'GROUP_BOOK_BLOB_READ_WRITE_TOKEN';

export interface GroupBookInvite {
  token: string;
  cohortId: string;
  familySlotId: string;
  cohortLabel: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

export function isWellFormedGroupBookToken(value: unknown): boolean {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function extractGroupBookToken(value: string): string | null {
  const trimmed = value.trim();
  if (isWellFormedGroupBookToken(trimmed)) return trimmed;
  const candidates = trimmed.match(/[A-Za-z0-9_-]{32,64}/g) ?? [];
  return candidates.find((candidate) => isWellFormedGroupBookToken(candidate)) ?? null;
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
  return {
    token: row.token,
    cohortId: row.cohortId,
    familySlotId: row.familySlotId,
    cohortLabel,
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

export function resolveGroupBookInvite(token: string): GroupBookInvite | null {
  if (!isWellFormedGroupBookToken(token)) return null;
  return groupBookInvites().find((invite) => invite.token === token) ?? null;
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
