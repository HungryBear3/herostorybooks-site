/** Explicit operator command. Dry preflight is default; --execute stages exact bytes then requests CAS adoption.
 * Never sends a customer proof, creates a review capability, prints, or changes payment. */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { put, get } from '@vercel/blob';
import sharp from 'sharp';
import { canonicalSourceHash } from '../src/lib/review-source-identity.ts';
import { manualArtifactPath, validateManualManifest, type ManualManifest } from '../src/lib/manual-media-proof-adoption.ts';
export async function runManualProofAdoption(args: string[]) {
  const [directory, reviewedManifestHash, baseUrl, mode] = args;
  if (!directory || !reviewedManifestHash || !baseUrl || (mode && mode !== '--execute')) throw new Error('Usage: adopt-manual-media-proof.ts PACKAGE_DIR REVIEWED_CANONICAL_MANIFEST_SHA256 BASE_URL [--execute]');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' && (url.hostname === 'herostorybooks.com' || /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname))
      || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('unsupported_target');
  const key = process.env.HSB_ORDER_ADMIN_KEY?.trim();
  if (!key) throw new Error('admin_key_required');
  const root = await realpath(directory);
  const manifestBytes = await readFile(path.join(root, 'manifest.json'));
  if (manifestBytes.length > 500 * 1024) throw new Error('manifest_too_large');
  const manifest: ManualManifest = JSON.parse(manifestBytes.toString());
  validateManualManifest(manifest, manifest.orderId, reviewedManifestHash);
  const artifacts = [];
  for (const a of [manifest.proof, ...manifest.images]) {
    const file = await realpath(path.join(root, a.filename));
    if (!file.startsWith(root + path.sep)) throw new Error('artifact_outside_package');
    const body = await readFile(file);
    if (body.length !== a.bytes || createHash('sha256').update(body).digest('hex') !== a.sha256) throw new Error('artifact_hash_mismatch');
    const type = a === manifest.proof ? 'application/pdf' : `image/${(await sharp(body).metadata()).format}`;
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(type)) throw new Error('artifact_type_mismatch');
    artifacts.push({ a, body, contentType: type });
  }
  const send = async (phase: 'preflight' | 'adopt') => {
    const response = await fetch(`${url.origin}/api/admin/orders/${manifest.orderId}/manual-proof`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-hsb-order-admin-key': key },
      body: JSON.stringify({ workFence: process.env.HSB_WORK_EVENT_ID && process.env.HSB_WORK_CLAIM_TOKEN ? { eventId: process.env.HSB_WORK_EVENT_ID, token: process.env.HSB_WORK_CLAIM_TOKEN } : undefined, mode: phase, manifest, expectedManifestHash: canonicalSourceHash(manifest), attestation: 'reviewed_exact_candidate' }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`adoption_${phase}_refused:${response.status}`);
    return result;
  };
  const preflight = await send('preflight');
  if (mode !== '--execute') return preflight;
  const token = process.env.HSB_PRIVATE_READ_WRITE_TOKEN?.trim();
  if (!token || token === process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new Error('private_credential_required');
  // Create-only, content-addressed staging. No arbitrary path and never overwrite.
  // On any upload ambiguity/failure stop; reconcile exact staged objects before rerun.
  for (const { a, body, contentType } of artifacts) {
    const pathname = manualArtifactPath(manifest, a);
    const existing = await get(pathname, { access: 'private', token, useCache: false });
    if (existing && existing.statusCode === 200) {
      if (existing.blob.pathname !== pathname || existing.blob.contentType !== contentType) throw new Error('existing_artifact_mismatch');
      const reader = existing.stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > a.bytes) throw new Error('existing_artifact_oversize'); chunks.push(next.value); }
      } finally { await reader.cancel(); }
      const found = Buffer.concat(chunks);
      if (found.length !== a.bytes || createHash('sha256').update(found).digest('hex') !== a.sha256) throw new Error('existing_artifact_mismatch');
    } else {
      const created = await put(pathname, body, { access: 'private', token, contentType, addRandomSuffix: false, allowOverwrite: false });
      if (created.pathname !== pathname) throw new Error('upload_path_mismatch');
    }
  }
  return send('adopt');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runManualProofAdoption(process.argv.slice(2))));
}
