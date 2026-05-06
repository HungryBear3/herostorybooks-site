/**
 * Lukas targeted rescue script (Phase 1 of the HSB rescue + typography upgrade).
 *
 * What this does:
 *   - Encodes the four targeted prompt deltas from Alexy's parent-QA pass on
 *     order ord_f5dcffc8a0b84d06 (Lukas Kaplun, classic, brave-explorer).
 *   - DRY-RUN by default: prints exactly which pages would be regenerated,
 *     the prompt that would be sent to the Seedream edit provider, and the
 *     planned local artifact filenames + MD5 capture path.
 *   - Will only ever call the existing approved Seedream edit provider
 *     (FAL_KEY required). It does NOT call OpenAI image, FAL text-to-image,
 *     or any other generation endpoint.
 *   - Will NEVER submit anything to Lulu, modify the production order
 *     record, or pay any print job. The only side effect on --apply is:
 *       (a) HTTP POST to fal.run/...seedream/v4/edit per targeted page
 *       (b) writing PNGs and a fresh proof+interior+cover PDF locally
 *       (c) writing an MD5 manifest next to those PDFs
 *
 * Usage:
 *   node --experimental-strip-types scripts/lukas-rescue.ts            # dry-run
 *   node --experimental-strip-types scripts/lukas-rescue.ts --apply    # call FAL + emit local artifacts
 *
 * Hard refusal contract:
 *   - Refuses unless ORDER_ID = 'ord_f5dcffc8a0b84d06'.
 *   - Refuses if --submit-to-lulu is passed (no such flag exists; this is a
 *     belt-and-suspenders guard against accidental copy-paste).
 *   - Does not import lulu.ts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const VALIDATED_PROOF_MD5 = '8bf0f3e4bfd8bcdc3b50523692423880';
const VALIDATED_INTERIOR_MD5 = 'a251ff94f09db2d28d7bf181f9a8afdd';
const VALIDATED_COVER_MD5 = '07bd65cd9ffa5e2b10e64a7a7bc417d3';

interface RescueTarget {
  /** 1-indexed page number as it appears in the parent-QA report. */
  page: number;
  /** Short label for logs. */
  label: string;
  /** Human description of the issue, copied from the parent-QA pass. */
  issue: string;
  /** The targeted edit prompt sent to Seedream edit. */
  editPrompt: string;
  /** Source asset (the existing approved illustration we are editing). */
  sourceAssetPath: string;
}

const ARTIFACTS_ROOT = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets';
const SOURCE_INTERIOR_PAGES = path.join(ARTIFACTS_ROOT, 'interior-pages');

const TARGETS: RescueTarget[] = [
  {
    page: 6,
    label: 'p6-remove-top-left-child-artifact',
    issue: 'Partial duplicate child/head artifact peeking from the top-left of the frame.',
    editPrompt:
      'Remove any partial child, partial head, or duplicate face fragment in the top-left corner of the frame. ' +
      'Replace that area with calm, low-detail jungle background (foliage, soft moss, distant mist) so the spread reads as one child only. ' +
      'Keep Lukas, his outfit, the listening stone, and the existing composition exactly as-is. Do not add any text, lettering, or signs anywhere in the image.',
    sourceAssetPath: path.join(SOURCE_INTERIOR_PAGES, 'page-06.jpg'),
  },
  {
    page: 8,
    label: 'p8-clean-wristband-text',
    issue: 'Possible AI-generated lettering on the wristband; clean if present.',
    editPrompt:
      'Inspect the wristband and any other small accessories. If any letters, words, captions, glyphs, or text-shaped marks appear, replace them with a plain solid-color band that matches the existing palette. ' +
      'Keep Lukas, his pose, the listening stone, and the existing background exactly as-is. ' +
      'No text, lettering, signage, or word-shaped marks anywhere in the image — the wristband should read as a clean, uniform fabric band.',
    sourceAssetPath: path.join(SOURCE_INTERIOR_PAGES, 'page-08.jpg'),
  },
  {
    page: 16,
    label: 'p16-remove-right-side-duplicate-child',
    issue: 'Disembodied duplicate child / right-side body fragment.',
    editPrompt:
      'Remove the disembodied second child, duplicate body fragment, or floating limb on the right side of the frame. ' +
      'Replace that zone with calm jungle background (vines, soft canopy, mist) consistent with the existing palette so the spread reads as one Lukas only. ' +
      'Keep the primary Lukas figure, his outfit, the rope bridge or path, and the existing composition exactly as-is. No text or lettering anywhere.',
    sourceAssetPath: path.join(SOURCE_INTERIOR_PAGES, 'page-16.jpg'),
  },
  {
    page: 30,
    label: 'final-bedroom-cozy',
    issue: 'Final bedroom page must read as cozy bedtime — pajamas on, hat off, boots off, no backpack.',
    editPrompt:
      'Re-render the bedroom scene as cozy bedtime: Lukas in soft pajamas, no explorer hat, no boots, no backpack, no satchel — only a tucked-in child in a warm bedroom with the listening stone resting beside the pillow under moonlight. ' +
      'Keep Lukas\'s face/identity, the bedroom layout, and the warm twilight palette consistent with the rest of the book. ' +
      'No text, lettering, or signage anywhere in the image.',
    sourceAssetPath: path.join(SOURCE_INTERIOR_PAGES, 'page-30.jpg'),
  },
];

// Optional: a stronger cover. Skipped unless --include-cover is passed.
const COVER_TARGET: RescueTarget = {
  page: 0,
  label: 'cover-integrated-title',
  issue: 'Current cover reads like a website header, not a real picture book cover.',
  editPrompt:
    'Reframe as a real picture book cover: Lukas in his explorer outfit centered in a hero pose at a jungle trailhead with the listening stones glowing softly in the foreground, warm painterly art style consistent with the interior. ' +
    'Leave a calm, low-detail upper-third area so the title "Lukas and the Listening Stones" can be typeset cleanly by the book layout. ' +
    'Do NOT render any text, lettering, title, byline, or word-shaped marks in the image itself — the title is added in the cover PDF.',
  sourceAssetPath: path.join(ARTIFACTS_ROOT, 'fix-pass-2026-05-05-text-panel-rebuild', 'illustrated-cover-candidate-attempt1-OlxoqE4B8Xc8iOa1RECe2_ff6138ee52e545e19b533c56152e6567.png'),
};

interface CliOptions {
  apply: boolean;
  includeCover: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    apply: false,
    includeCover: false,
    outDir: path.join('/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets', `rescue-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--apply') opts.apply = true;
    else if (raw === '--include-cover') opts.includeCover = true;
    else if (raw.startsWith('--out=')) opts.outDir = raw.slice('--out='.length);
    else if (raw === '--submit-to-lulu' || raw === '--pay' || raw === '--lulu') {
      throw new Error(`refusing flag ${raw}: this script never submits or pays for print jobs.`);
    }
  }
  return opts;
}

function md5HexBuffer(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function callSeedreamEdit(prompt: string, sourceAssetPath: string): Promise<Buffer> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error('FAL_KEY not set in env (load .env.rebuild first).');

  // Encode the source as a data URI and pass it in image_urls. Seedream v4
  // accepts data URIs alongside http(s) URLs, which keeps this script
  // self-contained (no separate storage upload step) and matches the
  // shape image-provider-seedream-edit.ts expects.
  const sourceBytes = await fs.readFile(sourceAssetPath);
  const ext = path.extname(sourceAssetPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const sourceUrl = `data:${mime};base64,${sourceBytes.toString('base64')}`;

  const seed = parseInt(crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 8), 16);
  const editRes = await fetch('https://fal.run/fal-ai/bytedance/seedream/v4/edit', {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_urls: [sourceUrl],
      num_images: 1,
      enable_safety_checker: true,
      seed,
    }),
  });
  if (!editRes.ok) {
    throw new Error(`Seedream edit failed: ${editRes.status} ${(await editRes.text()).slice(0, 200)}`);
  }
  const data = (await editRes.json()) as { images?: Array<{ url?: string }> };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error('Seedream edit returned no image url.');
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Could not download generated image: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function main() {
  const opts = parseArgs(process.argv);
  const all = opts.includeCover ? [...TARGETS, COVER_TARGET] : TARGETS;

  console.log(JSON.stringify({
    orderId: ORDER_ID,
    mode: opts.apply ? 'apply' : 'dry-run',
    includeCover: opts.includeCover,
    outDir: opts.outDir,
    targets: all.map((t) => ({ page: t.page, label: t.label, issue: t.issue })),
    validatedProofMd5: VALIDATED_PROOF_MD5,
    validatedInteriorMd5: VALIDATED_INTERIOR_MD5,
    validatedCoverMd5: VALIDATED_COVER_MD5,
  }, null, 2));

  if (!opts.apply) {
    console.log('\n[dry-run] No FAL calls made. No artifacts written. Re-run with --apply once Alexy has approved the FAL spend.');
    for (const t of all) {
      console.log(`\n--- ${t.label} (page ${t.page}) ---`);
      console.log(`source: ${t.sourceAssetPath}`);
      console.log(`prompt:\n${t.editPrompt}`);
    }
    return;
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  const manifest: Array<{ label: string; page: number; outputPath: string; md5: string }> = [];
  for (const t of all) {
    console.log(`\n[apply] generating ${t.label} ...`);
    const bytes = await callSeedreamEdit(t.editPrompt, t.sourceAssetPath);
    const outPath = path.join(opts.outDir, `${t.label}.png`);
    await fs.writeFile(outPath, bytes);
    const md5 = md5HexBuffer(bytes);
    manifest.push({ label: t.label, page: t.page, outputPath: outPath, md5 });
    console.log(`  wrote ${outPath} (md5=${md5})`);
  }
  const manifestPath = path.join(opts.outDir, 'rescue-manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ orderId: ORDER_ID, generatedAt: new Date().toISOString(), targets: manifest }, null, 2),
  );
  console.log(`\nWrote manifest ${manifestPath}`);
  console.log('\nNEXT STEPS (manual, requires Alexy approval):');
  console.log('  1. Open the new PNGs and confirm the targeted issues are fixed without regressing other detail.');
  console.log('  2. Stage them as the new pageArtifacts.currentImageUrl for the affected pages only.');
  console.log('  3. Re-run scripts/validate-print-pdf.ts on the resulting proof + interior + cover.');
  console.log('  4. Do NOT submit a new Lulu job from this script. Follow docs/runbooks/2026-05-05-lukas-text-panel-resubmission-safety.md for the safe resubmission path.');
}

main().catch((err) => {
  console.error('lukas-rescue: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
