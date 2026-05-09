/**
 * Lukas targeted rescue — pass 2.
 *
 * Second-pass polish on the outputs of rescue-2026-05-05T16-02-16-523Z/.
 * Same Seedream v4 edit provider as scripts/lukas-rescue.ts. Same hard
 * refusal contract. Same artifact pattern: PNGs + manifest only.
 *
 * Pass-1 QA flagged three residual issues:
 *   1. p16 — a rendered "16" page number sits at bottom-center inside the
 *      art (would clash with print pipeline page numbering).
 *   2. cover — upper third is busy (canopy, fireflies, archway keystone),
 *      which fights typeset title placement.
 *   3. p8 — faint sapling/leaf glyph in upper-right reads as a
 *      logomark-like text artifact (optional).
 *
 * Usage:
 *   node --experimental-strip-types scripts/lukas-rescue-pass2.ts            # dry-run
 *   node --experimental-strip-types scripts/lukas-rescue-pass2.ts --apply    # call FAL
 *
 * Hard refusals (same as pass 1):
 *   - ORDER_ID is locked.
 *   - --submit-to-lulu / --pay / --lulu flags throw.
 *   - Does not import lulu.ts. Does not write PDFs. Does not mutate any
 *     order record.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';

interface RescueTarget {
  page: number;
  label: string;
  issue: string;
  editPrompt: string;
  sourceAssetPath: string;
}

const ARTIFACTS_ROOT = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets';
const PASS1_DIR = path.join(ARTIFACTS_ROOT, 'rescue-2026-05-05T16-02-16-523Z');

const TARGETS: RescueTarget[] = [
  {
    page: 16,
    label: 'p16-remove-rendered-page-number',
    issue: 'A rendered "16" page number sits at bottom-center of the artwork. The print pipeline owns page numbering and the art must be clean.',
    editPrompt:
      'Remove the rendered number "16" (and any other numerals or text-shaped marks) at the bottom-center of the image. ' +
      'Replace that area with the same mossy stone-floor texture and palette already present at the bottom of the frame so the patch is invisible. ' +
      'Preserve everything else exactly: Lukas, his pose lifting the mossy slab, the temple columns, the carved figure, the frog, the sparkle ornament, the foliage, lighting, and color palette. ' +
      'Do NOT add any text, lettering, numerals, captions, signage, page numbers, or word-shaped marks anywhere in the image.',
    sourceAssetPath: path.join(PASS1_DIR, 'p16-remove-right-side-duplicate-child.png'),
  },
  {
    page: 0,
    label: 'cover-quiet-upper-third',
    issue: 'Upper third is too busy (canopy, fireflies, archway keystone) for typeset title placement.',
    editPrompt:
      'Quiet the upper third of the image so a typeset title can be placed cleanly. ' +
      'Reduce the visual density of the upper third: simplify or push back the vine canopy, soften the archway keystone, and remove any fireflies or sparkles in the top third. Replace with a calm warm gradient sky / soft glow that is low-detail and low-contrast — picture-book cover sky, not jungle clutter. ' +
      'Preserve the lower two-thirds exactly: Lukas in his explorer outfit centered in his hero pose, the archway opening, the frog, the glowing listening stones, and the painterly art style. ' +
      'Do NOT render any text, lettering, title, byline, page numbers, numerals, or word-shaped marks anywhere in the image — the title is added in the cover PDF.',
    sourceAssetPath: path.join(PASS1_DIR, 'cover-integrated-title.png'),
  },
  {
    page: 8,
    label: 'p8-remove-background-glyph',
    issue: 'Faint sapling/leaf logomark-shaped glyph in the upper-right background reads as a text artifact.',
    editPrompt:
      'Inspect the upper-right background area inside the archway. Remove any faint glyph, logomark, sapling-shaped mark, leaf-shaped sigil, or any other text-like or logo-like decorative mark in the background. ' +
      'Replace that zone with the same soft misty jungle/sky background tone already present so the patch is invisible. ' +
      'Preserve everything else exactly: Lukas, his face, his outfit, his hat, the wristband (which must remain plain — no letters, no glyphs), the backpack, boots, the archway stones, the surrounding vines, and the lighting/palette. ' +
      'Do NOT add any text, lettering, glyphs, sigils, signage, captions, page numbers, or word-shaped marks anywhere in the image.',
    sourceAssetPath: path.join(PASS1_DIR, 'p8-clean-wristband-text.png'),
  },
];

interface CliOptions {
  apply: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    apply: false,
    outDir: path.join(ARTIFACTS_ROOT, `rescue-pass2-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--apply') opts.apply = true;
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

  console.log(JSON.stringify({
    orderId: ORDER_ID,
    pass: 2,
    mode: opts.apply ? 'apply' : 'dry-run',
    outDir: opts.outDir,
    targets: TARGETS.map((t) => ({ page: t.page, label: t.label, issue: t.issue, source: t.sourceAssetPath })),
  }, null, 2));

  if (!opts.apply) {
    console.log('\n[dry-run] No FAL calls. Re-run with --apply to spend.');
    for (const t of TARGETS) {
      console.log(`\n--- ${t.label} (page ${t.page}) ---`);
      console.log(`source: ${t.sourceAssetPath}`);
      console.log(`prompt:\n${t.editPrompt}`);
    }
    return;
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  const manifest: Array<{ label: string; page: number; outputPath: string; sourcePath: string; md5: string }> = [];
  for (const t of TARGETS) {
    console.log(`\n[apply] generating ${t.label} ...`);
    const bytes = await callSeedreamEdit(t.editPrompt, t.sourceAssetPath);
    const outPath = path.join(opts.outDir, `${t.label}.png`);
    await fs.writeFile(outPath, bytes);
    const md5 = md5HexBuffer(bytes);
    manifest.push({ label: t.label, page: t.page, outputPath: outPath, sourcePath: t.sourceAssetPath, md5 });
    console.log(`  wrote ${outPath} (md5=${md5})`);
  }
  const manifestPath = path.join(opts.outDir, 'rescue-pass2-manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ orderId: ORDER_ID, pass: 2, generatedAt: new Date().toISOString(), targets: manifest }, null, 2),
  );
  console.log(`\nWrote manifest ${manifestPath}`);
  console.log('\nSTOP HERE for QA. No PDFs were rebuilt. No Lulu submission. No order mutation.');
}

main().catch((err) => {
  console.error('lukas-rescue-pass2: FAILED');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
