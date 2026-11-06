import { createHash } from 'node:crypto';
import { del, get, put } from '@vercel/blob';

import { requireToken } from './store.ts';

/**
 * Private storage for classroom local proof PDFs in the dedicated group-book
 * store. Create-only writes, bounded reads, exact-byte verification. Nothing
 * here publishes, releases or grants access to a proof.
 */
export const CLASSROOM_PROOF_STORE_MAX_BYTES = 64 * 1024 * 1024;
const COHORT = /^[A-Za-z0-9_-]{2,64}$/;
const ORDER = /^ord_[a-f0-9]{16}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export interface ClassroomProofArtifactRef {
  pathname: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export type ClassroomProofRead =
  | { state: 'found'; bytes: Buffer; contentType: string }
  | { state: 'missing' | 'unavailable' | 'too_large' };

export function classroomProofArtifactPath(cohortId: string, orderId: string, sha256: string): string {
  if (!COHORT.test(cohortId) || !ORDER.test(orderId) || !HEX64.test(sha256)) throw new Error('classroom_proof:invalid_path_input');
  return `group-book/proofs/${cohortId}/${orderId}/${sha256}.pdf`;
}

/** Streaming read that stops one byte past the cap. Only a 404 or empty result proves absence. */
export async function readClassroomProofArtifact(pathname: string): Promise<ClassroomProofRead> {
  let result: { statusCode?: number; stream?: ReadableStream<Uint8Array> | null; blob?: { contentType?: string } | null } | null;
  try {
    result = (await get(pathname, { access: 'private', token: requireToken(), useCache: false })) as unknown as typeof result;
  } catch {
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
      if (length > CLASSROOM_PROOF_STORE_MAX_BYTES) return { state: 'too_large' };
      chunks.push(value);
    }
  } catch {
    return { state: 'unavailable' };
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { state: 'found', bytes: Buffer.concat(chunks), contentType: result.blob?.contentType ?? '' };
}

/** Exact stored identity: present, same length, same digest, PDF type and header. */
export async function classroomProofArtifactRefusal(artifact: ClassroomProofArtifactRef): Promise<string | null> {
  const read = await readClassroomProofArtifact(artifact.pathname);
  if (read.state === 'missing') return 'artifact_missing';
  if (read.state !== 'found') return 'artifact_unavailable';
  const found = read as { bytes: Buffer; contentType: string };
  if (found.bytes.byteLength !== artifact.bytes
    || createHash('sha256').update(found.bytes).digest('hex') !== artifact.sha256
    || found.contentType !== 'application/pdf'
    || found.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return 'artifact_mismatch';
  return null;
}

/** Create-only write. A lost acknowledgement or an existing object is settled by the readback. */
export async function writeClassroomProofArtifact(artifact: ClassroomProofArtifactRef, bytes: Buffer): Promise<string | null> {
  try {
    await put(artifact.pathname, bytes, {
      access: 'private',
      token: requireToken(),
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 0,
      contentType: artifact.contentType,
    });
  } catch {
    // Decided by the exact readback below, never by this error.
  }
  return await classroomProofArtifactRefusal(artifact);
}

/** Best effort: an unadopted proof must not outlive the refusal that orphaned it. */
export async function discardClassroomProofArtifact(pathname: string): Promise<void> {
  try {
    await del(pathname, { token: requireToken() });
  } catch {
    console.error('[group-book/proof] unadopted artifact discard failed');
  }
}
