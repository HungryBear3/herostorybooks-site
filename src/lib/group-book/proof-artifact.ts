import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  adoptClassroomProofCustody,
  CLASSROOM_PROOF_ADOPTION_KIND,
  CLASSROOM_PROOF_ADOPTION_STATUS,
  CLASSROOM_PROOF_MAX_BYTES,
  classroomProofAdoptionOf,
  classroomProofAdoptionRefusal,
  classroomSettlementAuthority,
  readOrderVersioned,
  type ClassroomSettlementIdentity,
  type OrderRecord,
} from '../orders.ts';
import { assertClassroomAssemblyCurrent, readClassroomManifest, type ClassroomManifest } from './assembly.ts';
import { classroomProofContent, renderClassroomProofPdf, type ClassroomProofContent } from './proof-pdf.ts';
import {
  classroomProofArtifactPath,
  classroomProofArtifactRefusal,
  discardClassroomProofArtifact,
  writeClassroomProofArtifact,
  type ClassroomProofArtifactRef,
} from './proof-store.ts';
import { loadClassroomRoster } from './roster.ts';
import { loadEffectiveGroupBookSubmission } from './store.ts';

/**
 * Classroom local proof producer and adoption contract. Scoped to bound
 * classroom orders: retail manual adoption and its fences are not touched.
 *
 * Authority is the settled-zero custody in orders.ts plus the current manifest
 * and roster, rechecked before storage and inside the adoption CAS. The private
 * Blob store has no multi-object transaction, so a withdrawal can still land
 * after the last recheck; adoption is therefore never a release, and
 * verifyClassroomProofAdoption must pass again at every later use. No route
 * mounts this module, and it sends, prints and publishes nothing.
 */
export const CLASSROOM_PROOF_APPROVED_ASSETS = Object.freeze([
  { path: 'public/classroom/assets/lukas-biggest-day-page-09.jpg', sha256: 'a8087f1dc9755e0b33a07acbd81b4129b3eaf729ba30aa21fa60d7a35b9e163e' },
  { path: 'public/classroom/assets/lukas-biggest-day-page-19.jpg', sha256: '83f6f3a5f54603383743d0e0809349b98d6359690c15cd0b8b10b322a42b20f4' },
  { path: 'public/classroom/assets/pasta-planet-printed-book.jpg', sha256: 'a40f21ba2229a135a88d9fe97b77dd5ac79b103315722d169de49d9ee54bb079' },
]);
const ORDER_ID = /^ord_[a-f0-9]{16}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClassroomProofDeps {
  now?: () => Date;
  /** Test seam for controlled interleavings; a no-op in production. */
  barrier?: (point: string) => Promise<void>;
}

export type ClassroomProofOutcome =
  | { state: 'adopted' | 'replayed'; adoption: Record<string, unknown> }
  | { state: 'refused'; reason: string };

export type ClassroomProofVerification =
  | { ok: true; adoption: Record<string, unknown> }
  | { ok: false; reason: string };

type Refused = { state: 'refused'; reason: string };
const refused = (reason: string): Refused => ({ state: 'refused', reason });
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

interface ProofContext {
  order: OrderRecord;
  identity: ClassroomSettlementIdentity;
  manifest: ClassroomManifest;
  names: string[];
}

/** Eligible first names in manifest order; a string is the refusal reason. */
async function participantNames(manifest: ClassroomManifest): Promise<string[] | string> {
  const roster = await loadClassroomRoster(manifest.cohortId);
  if (roster.state !== 'complete') return 'roster_not_ready';
  const invites = (roster as { invites: Awaited<ReturnType<typeof loadClassroomRoster>> extends infer R ? R extends { invites: infer I } ? I : never : never }).invites;
  const names: string[] = [];
  for (const participant of manifest.participants) {
    const invite = invites.find((row) => row.familySlotId === participant.familySlotId);
    if (!invite) return 'participation_changed';
    const effective = await loadEffectiveGroupBookSubmission(invite).catch(() => undefined);
    if (effective === undefined) return 'roster_not_ready';
    if (!effective || effective.effectiveStatus !== 'submitted' || effective.effectiveOmitFromProofAndPrint
      || effective.id !== participant.submissionId || effective.familyStorageKey !== participant.familyStorageKey
      || JSON.stringify(effective.photos.map((photo) => photo.pathname)) !== JSON.stringify(participant.photoPaths)) {
      return 'participation_changed';
    }
    const name = effective.child.firstName.trim();
    if (!name) return 'participation_changed';
    names.push(name);
  }
  return names;
}

async function currentProofContext(orderId: string, now: () => Date): Promise<ProofContext | Refused> {
  const versioned = await readOrderVersioned(orderId);
  if (!versioned) return refused('order_not_found');
  const order = versioned.order;
  const authority = classroomSettlementAuthority(order);
  if (authority.ok === false) return refused((authority as { reason: string }).reason);
  const current = await assertClassroomAssemblyCurrent(order.groupBookAssembly, { now });
  if (current.ok === false) return refused((current as { reason: string }).reason);
  const read = await readClassroomManifest(order.groupBookAssembly, { now });
  if (read.state !== 'found') return refused((read as { reason: string }).reason);
  const manifest = (read as { manifest: ClassroomManifest }).manifest;
  const names = await participantNames(manifest);
  if (typeof names === 'string') return refused(names);
  return { order, identity: (authority as { identity: ClassroomSettlementIdentity }).identity, manifest, names };
}

/** Exact pinned bytes as ArrayBuffers for the standalone PDF build. */
async function approvedAssetImages(): Promise<ArrayBuffer[] | null> {
  const images: ArrayBuffer[] = [];
  for (const asset of CLASSROOM_PROOF_APPROVED_ASSETS) {
    const bytes = await readFile(path.join(process.cwd(), asset.path));
    if (sha256(bytes) !== asset.sha256) return null;
    images.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return images;
}

const contentDigestOf = (content: ClassroomProofContent) => sha256(JSON.stringify(content));
const assetDigests = () => CLASSROOM_PROOF_APPROVED_ASSETS.map((asset) => asset.sha256);

/** Re-verify an adoption for use: settlement, assembly, roster and exact stored bytes. */
export async function verifyClassroomProofAdoption(orderId: string, deps: ClassroomProofDeps = {}): Promise<ClassroomProofVerification> {
  const now = deps.now ?? (() => new Date());
  try {
    const context = await currentProofContext(orderId, now);
    if ('state' in context) return { ok: false, reason: context.reason };
    const adoption = classroomProofAdoptionOf(context.order);
    if (!adoption) return { ok: false, reason: 'adoption_missing' };
    const identityRefusal = classroomProofAdoptionRefusal(adoption, context.order);
    if (identityRefusal) return { ok: false, reason: identityRefusal };
    const content = classroomProofContent(context.names, adoption.assetSha256 as string[]);
    if (contentDigestOf(content) !== adoption.contentDigest) return { ok: false, reason: 'participation_changed' };
    const artifactRefusal = await classroomProofArtifactRefusal(adoption.artifact as ClassroomProofArtifactRef);
    return artifactRefusal ? { ok: false, reason: artifactRefusal } : { ok: true, adoption };
  } catch {
    return { ok: false, reason: 'proof_verification_failed' };
  }
}

/**
 * Settled-zero bound order -> current eligible roster -> real private PDF ->
 * readback -> append-once adoption. Refusal after storage discards the object,
 * because the adopted withdrawal policy also covers work in progress.
 */
export async function produceAndAdoptClassroomProof(orderId: string, deps: ClassroomProofDeps = {}): Promise<ClassroomProofOutcome> {
  if (!ORDER_ID.test(orderId)) return refused('order_identity');
  const now = deps.now ?? (() => new Date());
  const barrier = deps.barrier ?? (async () => {});
  let stored: string | null = null;
  try {
    const context = await currentProofContext(orderId, now);
    if ('state' in context) return context;
    if (context.order.classroomProofAdoption !== undefined) {
      const verified = await verifyClassroomProofAdoption(orderId, deps);
      if (verified.ok === false) return refused((verified as { reason: string }).reason);
      return { state: 'replayed', adoption: (verified as { adoption: Record<string, unknown> }).adoption };
    }
    const images = await approvedAssetImages();
    if (!images) return refused('approved_asset_mismatch');
    const content = classroomProofContent(context.names, assetDigests());
    const contentDigest = contentDigestOf(content);
    const createdAt = now();
    const pdf = await renderClassroomProofPdf(content, images, createdAt);
    if (pdf.byteLength > CLASSROOM_PROOF_MAX_BYTES) return refused('artifact_too_large');
    await barrier('producer:rendered');

    // Nothing reaches storage unless authority and roster still hold.
    const recheck = await currentProofContext(orderId, now);
    if ('state' in recheck) return recheck;
    if (recheck.manifest.digest !== context.manifest.digest
      || contentDigestOf(classroomProofContent(recheck.names, assetDigests())) !== contentDigest) {
      return refused('participation_changed');
    }
    const binding = recheck.order.groupBookAssembly!;
    const digest = sha256(pdf);
    const artifact = {
      pathname: classroomProofArtifactPath(binding.cohortId, orderId, digest),
      sha256: digest,
      bytes: pdf.byteLength,
      contentType: 'application/pdf',
      createdAt: createdAt.toISOString(),
      retentionUntil: new Date(createdAt.getTime() + RETENTION_MS).toISOString(),
    };
    stored = artifact.pathname;
    const writeRefusal = await writeClassroomProofArtifact(artifact, pdf);
    if (writeRefusal) {
      await discardClassroomProofArtifact(artifact.pathname);
      return refused(writeRefusal);
    }
    const adoption = {
      schemaVersion: 1,
      kind: CLASSROOM_PROOF_ADOPTION_KIND,
      status: CLASSROOM_PROOF_ADOPTION_STATUS,
      customerReleaseAuthorized: false,
      orderId,
      cohortId: binding.cohortId,
      manifestDigest: binding.digest,
      manifestExpiresAt: binding.expiresAt,
      participantCount: binding.participantCount,
      settlement: {
        providerEventId: recheck.identity.providerEventId,
        sessionId: recheck.identity.sessionId,
        dispatchAttemptId: recheck.identity.dispatchAttemptId,
        amountTotalCents: 0,
      },
      artifact,
      contentDigest,
      assetSha256: assetDigests(),
      adoptedAt: now().toISOString(),
    };
    await barrier('producer:before_adopt');
    const adopted = await adoptClassroomProofCustody(orderId, {
      adoption,
      guard: async () => {
        const guarded = await currentProofContext(orderId, now);
        if ('state' in guarded) return guarded.reason;
        if (contentDigestOf(classroomProofContent(guarded.names, assetDigests())) !== contentDigest) return 'participation_changed';
        await barrier('producer:adopt_guarded');
        return null;
      },
    });
    if (adopted.ok === false) {
      await discardClassroomProofArtifact(artifact.pathname);
      return refused((adopted as { reason: string }).reason);
    }
    return { state: 'adopted', adoption };
  } catch {
    if (stored) await discardClassroomProofArtifact(stored);
    return refused('proof_production_failed');
  }
}
