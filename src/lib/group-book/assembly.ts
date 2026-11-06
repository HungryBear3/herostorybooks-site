import { createHash } from 'node:crypto';
import { get, put } from '@vercel/blob';

import { validateGroupBookAssemblyBinding, type GroupBookAssemblyBinding } from '../orders.ts';
import { loadGroupBookAdmission, type AdmittedParticipant, type GroupBookExportSnapshot } from './export.ts';
import { requireToken } from './store.ts';

/**
 * Private classroom assembly manifest: the exact admitted snapshot an order is
 * bound to. Create-only, canonical bytes, bounded strict reads, fixed expiry.
 *
 * The private Blob store has no multi-object transaction: publication, the
 * admission rechecks and order persistence are separate operations. Callers
 * recheck current admission after publication and immediately before order
 * persistence, and nothing here authorizes release.
 */
export const CLASSROOM_MANIFEST_MAX_BYTES = 262_144;
export const CLASSROOM_MANIFEST_MAX_PARTICIPANTS = 100;
export const CLASSROOM_MANIFEST_MAX_PHOTOS = 5;
export const CLASSROOM_MANIFEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KIND = 'hsb-classroom-assembly-manifest';
const MANIFEST_KEYS = ['cohortId', 'createdAt', 'digest', 'expiresAt', 'kind', 'participantCount', 'participants', 'schemaVersion'];
const PARTICIPANT_KEYS = ['familySlotId', 'familyStorageKey', 'photoPaths', 'policyDigest', 'submissionId'];
const COHORT = /^[A-Za-z0-9_-]{2,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SLOT = /^[A-Za-z0-9_-]{1,128}$/;
const PHOTO_NAME = /^[A-Za-z0-9_-]{1,128}\.[a-z0-9]{1,8}$/;

export interface ClassroomManifest {
  schemaVersion: 1;
  kind: typeof KIND;
  cohortId: string;
  digest: string;
  participantCount: number;
  createdAt: string;
  expiresAt: string;
  participants: AdmittedParticipant[];
}

export type ManifestRefusal =
  | 'missing' | 'expired' | 'too_large' | 'invalid_utf8' | 'noncanonical' | 'malformed' | 'mismatch'
  | 'unavailable' | 'collision' | 'too_many_participants' | 'too_many_photos' | 'invalid_snapshot' | 'invalid_binding'
  | 'invalid_clock';

export type ManifestRead = { state: 'found'; manifest: ClassroomManifest } | { state: 'refused'; reason: ManifestRefusal };
export type ManifestPublication =
  | { state: 'published' | 'replayed'; manifest: ClassroomManifest }
  | { state: 'refused'; reason: ManifestRefusal };
export type AssemblyCheck = { ok: true } | { ok: false; reason: string };

type Clock = { now?: () => Date };

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

export function encodeClassroomManifest(manifest: ClassroomManifest): string {
  return canonical(manifest);
}

export function classroomManifestPath(cohortId: string, digest: string): string {
  if (!COHORT.test(cohortId) || !HEX64.test(digest)) throw new Error('classroom_manifest:invalid_path_input');
  return `group-book/assembly-manifests/${cohortId}/${digest}.json`;
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The ONE authoritative digest: export.ts snapshotOf over the AdmittedParticipant
 * field projection, in export field order. No alternative projection is accepted.
 */
function exportDigest(cohortId: string, participants: AdmittedParticipant[]): string {
  const projection = participants.map((p) => ({
    familySlotId: p.familySlotId, familyStorageKey: p.familyStorageKey, submissionId: p.submissionId,
    photoPaths: p.photoPaths, policyDigest: p.policyDigest,
  }));
  return hash(JSON.stringify([cohortId, projection]));
}
function digestMatches(cohortId: string, participants: AdmittedParticipant[], digest: string): boolean {
  return exportDigest(cohortId, participants) === digest;
}

/** Finite clock whose derived 30-day expiry is also representable; otherwise null. */
function clockNow(clock: Clock): Date | null {
  let now: unknown;
  try {
    now = clock.now ? clock.now() : new Date();
  } catch {
    return null;
  }
  if (!(now instanceof Date)) return null;
  const ms = now.getTime();
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms + CLASSROOM_MANIFEST_TTL_MS).getTime())) return null;
  return new Date(ms);
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
}

function canonicalIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

/** Bounds first (never truncate), then exact structure and own-key photo prefixes. */
function participantsProblem(participants: unknown): 'too_many_participants' | 'too_many_photos' | 'invalid' | null {
  if (!Array.isArray(participants)) return 'invalid';
  if (participants.length > CLASSROOM_MANIFEST_MAX_PARTICIPANTS) return 'too_many_participants';
  if (participants.length === 0) return 'invalid';
  if (participants.some((row) => Array.isArray((row as { photoPaths?: unknown })?.photoPaths)
    && (row as { photoPaths: unknown[] }).photoPaths.length > CLASSROOM_MANIFEST_MAX_PHOTOS)) return 'too_many_photos';
  let previous: string | null = null;
  for (const row of participants) {
    if (!exactKeys(row, PARTICIPANT_KEYS)) return 'invalid';
    const { familySlotId, familyStorageKey, photoPaths, policyDigest, submissionId } = row;
    if (typeof familySlotId !== 'string' || !SLOT.test(familySlotId)) return 'invalid';
    if (previous !== null && !(previous < familySlotId)) return 'invalid';
    previous = familySlotId;
    if (typeof familyStorageKey !== 'string' || !HEX64.test(familyStorageKey)) return 'invalid';
    if (typeof policyDigest !== 'string' || !HEX64.test(policyDigest)) return 'invalid';
    if (typeof submissionId !== 'string' || !SLOT.test(submissionId)) return 'invalid';
    if (!Array.isArray(photoPaths)) return 'invalid';
    const prefix = `group-book/photos/${familyStorageKey}/`;
    const seen = new Set<string>();
    for (const photo of photoPaths) {
      if (typeof photo !== 'string' || !photo.startsWith(prefix) || !PHOTO_NAME.test(photo.slice(prefix.length)) || seen.has(photo)) return 'invalid';
      seen.add(photo);
    }
  }
  return null;
}

/** Structural + semantic validation of a parsed manifest (no binding, no clock). */
function manifestProblem(value: unknown): 'malformed' | 'mismatch' | null {
  if (!exactKeys(value, MANIFEST_KEYS)) return 'malformed';
  const m = value as unknown as ClassroomManifest;
  if (m.schemaVersion !== 1 || m.kind !== KIND || typeof m.cohortId !== 'string' || !COHORT.test(m.cohortId)
    || typeof m.digest !== 'string' || !HEX64.test(m.digest) || !Number.isInteger(m.participantCount)
    || !canonicalIso(m.createdAt) || !canonicalIso(m.expiresAt)) return 'malformed';
  if (participantsProblem(m.participants) !== null) return 'malformed';
  if (m.participantCount !== m.participants.length) return 'mismatch';
  if (Date.parse(m.expiresAt) - Date.parse(m.createdAt) !== CLASSROOM_MANIFEST_TTL_MS) return 'mismatch';
  if (!digestMatches(m.cohortId, m.participants, m.digest)) return 'mismatch';
  return null;
}

type RawRead = { state: 'found'; bytes: Uint8Array } | { state: 'missing' | 'unavailable' | 'too_large' };

/** Streaming read that stops one byte past the cap. */
async function readRaw(pathname: string): Promise<RawRead> {
  let result: { statusCode?: number; stream?: ReadableStream<Uint8Array> | null } | null;
  try {
    result = (await get(pathname, { access: 'private', token: requireToken(), useCache: false })) as unknown as typeof result;
  } catch {
    // Only a 404 or empty result proves absence (as store.ts readPrivateObject).
    return { state: 'unavailable' };
  }
  if (!result || result.statusCode === 404) return { state: 'missing' };
  if ((result.statusCode !== undefined && result.statusCode !== 200) || !result.stream) return { state: 'unavailable' };
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > CLASSROOM_MANIFEST_MAX_BYTES) return { state: 'too_large' };
      chunks.push(value);
    }
  } catch {
    return { state: 'unavailable' };
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { state: 'found', bytes: Buffer.concat(chunks) };
}

/** Raw bytes -> manifest: fatal UTF-8, JSON, exact canonical bytes, structure, semantics. */
function decodeManifest(bytes: Uint8Array): ManifestRead {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { state: 'refused', reason: 'invalid_utf8' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'refused', reason: 'malformed' };
  }
  if (canonical(parsed) !== text) return { state: 'refused', reason: 'noncanonical' };
  const problem = manifestProblem(parsed);
  if (problem) return { state: 'refused', reason: problem };
  return { state: 'found', manifest: parsed as ClassroomManifest };
}

/** Strict bounded read of the manifest a binding names; expiry enforced on every use. */
export async function readClassroomManifest(binding: unknown, clock: Clock = {}): Promise<ManifestRead> {
  if (!validateGroupBookAssemblyBinding(binding)) return { state: 'refused', reason: 'invalid_binding' };
  const now = clockNow(clock);
  if (!now) return { state: 'refused', reason: 'invalid_clock' };
  const raw = await readRaw(classroomManifestPath(binding.cohortId, binding.digest));
  if (raw.state !== 'found') return { state: 'refused', reason: raw.state };
  const decoded = decodeManifest(raw.bytes);
  if (decoded.state !== 'found') return decoded;
  const m = decoded.manifest;
  if (m.cohortId !== binding.cohortId || m.digest !== binding.digest
    || m.participantCount !== binding.participantCount || m.expiresAt !== binding.expiresAt) {
    return { state: 'refused', reason: 'mismatch' };
  }
  if (now.getTime() >= Date.parse(m.expiresAt)) return { state: 'refused', reason: 'expired' };
  return decoded;
}

/**
 * Create-only publication. A collision is accepted only when the stored record
 * is a valid, unexpired manifest for the identical snapshot; its original
 * creation and expiry are reused, never renewed.
 */
export async function publishClassroomManifest(
  snapshot: GroupBookExportSnapshot,
  options: Clock & { barrier?: (point: string) => Promise<void> } = {},
): Promise<ManifestPublication> {
  const now = clockNow(options);
  if (!now) return { state: 'refused', reason: 'invalid_clock' };
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.cohortId !== 'string' || !COHORT.test(snapshot.cohortId)
    || typeof snapshot.digest !== 'string' || !HEX64.test(snapshot.digest)) return { state: 'refused', reason: 'invalid_snapshot' };
  const problem = participantsProblem(snapshot.participants);
  if (problem === 'too_many_participants' || problem === 'too_many_photos') return { state: 'refused', reason: problem };
  if (problem || !digestMatches(snapshot.cohortId, snapshot.participants, snapshot.digest)) return { state: 'refused', reason: 'invalid_snapshot' };

  const createdAt = new Date(now.getTime());
  const manifest: ClassroomManifest = {
    schemaVersion: 1,
    kind: KIND,
    cohortId: snapshot.cohortId,
    digest: snapshot.digest,
    participantCount: snapshot.participants.length,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + CLASSROOM_MANIFEST_TTL_MS).toISOString(),
    participants: snapshot.participants.map((p) => ({
      familySlotId: p.familySlotId, familyStorageKey: p.familyStorageKey, submissionId: p.submissionId,
      photoPaths: [...p.photoPaths], policyDigest: p.policyDigest,
    })),
  };
  const body = encodeClassroomManifest(manifest);
  if (Buffer.byteLength(body, 'utf8') > CLASSROOM_MANIFEST_MAX_BYTES) return { state: 'refused', reason: 'too_large' };
  const pathname = classroomManifestPath(manifest.cohortId, manifest.digest);

  await options.barrier?.('manifest:before_put');
  try {
    await put(pathname, body, {
      access: 'private', token: requireToken(), allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) return { state: 'refused', reason: 'unavailable' };
    return adoptExisting(pathname, manifest, now);
  }
  // Strict readback of our own create: the exact canonical bytes just written.
  const written = await readRaw(pathname);
  if (written.state === 'missing') return { state: 'refused', reason: 'missing' };
  if (written.state !== 'found') return { state: 'refused', reason: 'unavailable' };
  if (Buffer.compare(Buffer.from(written.bytes), Buffer.from(body, 'utf8')) !== 0) return { state: 'refused', reason: 'collision' };
  const confirmed = decodeManifest(written.bytes);
  if (confirmed.state !== 'found') return { state: 'refused', reason: 'collision' };
  return { state: 'published', manifest: confirmed.manifest };
}

/** Collision: only a valid, identical, unexpired original is reused (its own creation/expiry). */
async function adoptExisting(pathname: string, manifest: ClassroomManifest, now: Date): Promise<ManifestPublication> {
  const existing = await readRaw(pathname);
  if (existing.state === 'unavailable') return { state: 'refused', reason: 'unavailable' };
  if (existing.state !== 'found') return { state: 'refused', reason: 'collision' };
  const decoded = decodeManifest(existing.bytes);
  if (decoded.state !== 'found') return { state: 'refused', reason: 'collision' };
  const stored = decoded.manifest;
  if (stored.cohortId !== manifest.cohortId || stored.digest !== manifest.digest
    || stored.participantCount !== manifest.participantCount
    || canonical(stored.participants) !== canonical(manifest.participants)) return { state: 'refused', reason: 'collision' };
  if (now.getTime() >= Date.parse(stored.expiresAt)) return { state: 'refused', reason: 'expired' };
  return { state: 'replayed', manifest: stored };
}

/**
 * Current-assembly assertion for every use of a bound order: the manifest is
 * present, canonical, unexpired and matches the binding, and CURRENT admission
 * is ready with exactly the bound participation. Read-only.
 */
export async function assertClassroomAssemblyCurrent(binding: unknown, clock: Clock = {}): Promise<AssemblyCheck> {
  if (!validateGroupBookAssemblyBinding(binding)) return { ok: false, reason: 'invalid_binding' };
  const read = await readClassroomManifest(binding, clock);
  if (read.state !== 'found') return { ok: false, reason: read.reason };
  let admission: Awaited<ReturnType<typeof loadGroupBookAdmission>>;
  try {
    admission = await loadGroupBookAdmission(binding.cohortId);
  } catch {
    return { ok: false, reason: 'roster_not_ready' };
  }
  if (admission.state !== 'ready') return { ok: false, reason: 'roster_not_ready' };
  if (admission.eligible.length === 0 || !digestMatches(binding.cohortId, admission.eligible, binding.digest)) {
    return { ok: false, reason: 'participation_changed' };
  }
  return { ok: true };
}

export type { GroupBookAssemblyBinding };
