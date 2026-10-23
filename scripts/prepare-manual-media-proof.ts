/** Offline-only preparation. Never imports a store writer, provider, or sender. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';
import { NEW_PROOF_LAYOUT_VERSION } from '../src/lib/fulfillment-types.ts';
import { validateStoryPageSet } from '../src/lib/story-page-contract.ts';
import { canonicalSourceHash } from '../src/lib/review-source-identity.ts';

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export { assertPreparationOrder, assertSnapshotCurrent } from '../src/lib/manual-media-proof-contract.ts';
import { assertSnapshotCurrent } from '../src/lib/manual-media-proof-contract.ts';
export type ManualSource = { orderId: string; expectedOrderHash: string; story: StoryContent; images: string[] };
export async function prepareManualMediaProof(order: OrderRecord, source: ManualSource, inputRoot: string, output: string) {
  assertSnapshotCurrent(order, source.expectedOrderHash);
  if (source.orderId !== order.id) throw new Error('order_binding_mismatch');
  const story = source.story;
  if (story?.dedication) throw new Error('dedication_not_supported_by_current_review_model');
  if (!story || typeof story.title !== 'string' || !story.title.trim() || !Array.isArray(story.pages)
    || !Array.isArray(source.images) || source.images.length !== story.pages.length) throw new Error('invalid_story');
  const root = await realpath(inputRoot);
  const images: Buffer[] = [];
  for (const relative of source.images) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':')) throw new Error('local_relative_images_required');
    const resolved = await realpath(path.resolve(root, relative));
    if (!resolved.startsWith(root + path.sep)) throw new Error('image_outside_input_root');
    const bytes = await readFile(resolved);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('image_too_large');
    const metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '')) throw new Error('png_or_jpeg_required');
    // Decode now; renderer's graceful fallback must not hide corrupt art.
    await sharp(bytes, { limitInputPixels: 40000000 }).raw().toBuffer();
    images.push(bytes);
  }
  const pages = story.pages.map((p, i) => {
    if (typeof p.imagePrompt !== 'string' || !p.imagePrompt.trim()) throw new Error('base_prompt_required');
    if (p.pageNum !== i + 1 || p.proofCardOverride) throw new Error('invalid_page_identity_or_override');
    return { pageIndex: i, storyText: p.story, textLayout: p.textLayout, currentImageUrl: `sha256:${sha256(images[i])}`, acceptedImageUrl: null, accepted: false };
  });
  const failure = validateStoryPageSet(pages, order.bookFormat, NEW_PROOF_LAYOUT_VERSION);
  if (failure) throw new Error(`page_contract:${failure.code}`);
  const version = canonicalSourceHash({ orderId: order.id, expectedOrderHash: source.expectedOrderHash, story, pages });
  // Exclusive directory creation: never overwrite an earlier candidate.
  await mkdir(output, { recursive: false, mode: 0o700 });
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const target = path.resolve(output, `page-${i + 1}.image`);
    await writeFile(target, images[i], { flag: 'wx', mode: 0o600 });
    paths.push(target);
  }
  const { buildPdf } = await import('../src/lib/pdf-builder.ts');
  const pdf = await buildPdf(story, { ...order, layoutVersion: NEW_PROOF_LAYOUT_VERSION }, [paths[0], ...paths]);
  await writeFile(path.join(output, 'candidate.pdf'), pdf, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schema: 'hsb-manual-media-proof-preparation-v1', orderId: order.id,
    expectedOrderHash: source.expectedOrderHash, candidateVersion: version,
    status: 'local_candidate_not_adopted', customerReleaseAuthorized: false,
    proof: { filename: 'candidate.pdf', sha256: sha256(pdf), bytes: pdf.length },
    images: images.map((bytes, i) => ({ filename: `page-${i + 1}.image`, sha256: sha256(bytes), bytes: bytes.length })),
    story, layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    remainingGates: ['visual_precision_QA', 'fresh_order_versioned_read', 'atomic_private_artifact_adoption', 'existing_page_review_and_release_gates'],
  };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [orderFile, sourceFile, output] = process.argv.slice(2);
  if (!orderFile || !sourceFile || !output) throw new Error('Usage: prepare-manual-media-proof.ts ORDER.json SOURCE.json NEW_OUTPUT_DIR');
  const order = JSON.parse(await readFile(orderFile, 'utf8'));
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  const result = await prepareManualMediaProof(order, source, path.dirname(path.resolve(sourceFile)), output);
  console.log(JSON.stringify({ status: result.status, candidateVersion: result.candidateVersion, proof: result.proof }));
}
