import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import {
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderRecord,
} from '../src/lib/orders.ts';
import { buildPdf, buildPrintCoverPdf } from '../src/lib/pdf-builder.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const EXPECTED_EXISTING_PRINT_JOB_ID = '2857729';
const BRIEF = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets';
const POLISH5 = path.join(BRIEF, 'polish-pass5-2026-05-05T19-52-31-658Z');
const FRONT_COVER_FILE = path.join(POLISH5, 'cover-frameless-fullbleed.png');
const BACK_COVER_FILE = path.join(POLISH5, 'back-cover-design.png');
const FRONT_COVER_EXPECTED_MD5 = '50921711aea6ee2c0347c83bfd6910d1';
const BACK_COVER_EXPECTED_MD5 = 'b2701f8f2fce7d664a6ced8266384a63';
const TITLE = 'Lukas and the Listening Stones';
const BACK_COVER_BLURB = 'When Lukas discovers a circle of stones that hums back to him, the jungle opens a secret path of bridges, fireflies, and brave choices. With curiosity in his pocket and kindness as his compass, he learns that listening closely can turn an ordinary day into a hero-sized adventure.';

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function readChecked(file: string, expectedMd5: string) {
  const buffer = await readFile(file);
  const digest = md5(buffer);
  if (digest !== expectedMd5) {
    throw new Error(`${file} md5 mismatch: expected ${expectedMd5}, got ${digest}`);
  }
  return { buffer, digest };
}

function requireApplyFlag(): boolean {
  return process.argv.includes('--apply');
}

async function putBlob(pathname: string, buffer: Buffer, contentType: string, apply: boolean, token: string) {
  const blobPath = withBlobNamespace(pathname);
  if (!apply) return `[dry-run] ${blobPath}`;
  const blob = await put(blobPath, buffer, {
    access: getBlobAccessMode(),
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return blob.url;
}

function buildStory(order: OrderRecord): StoryContent {
  const pages = (order.pageArtifacts ?? [])
    .slice()
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((page, i) => ({
      pageNum: i + 1,
      sceneTitle: '',
      story: page.storyText,
      imagePrompt: page.basePrompt,
      textLayout: page.textLayout ?? { zone: 'bottom_band', colorMode: 'auto', panelStyle: 'translucent_cream' },
    }));

  return {
    title: order.printTitle || TITLE,
    dedication: order.giftMessage || `For ${order.childName.split(/\s+/)[0] || order.childName}`,
    characterDescription: order.pageArtifacts?.[0]?.characterAnchor || order.characterNotes || '',
    pages,
  };
}

async function main() {
  const apply = requireApplyFlag();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');

  const order = await getOrder(ORDER_ID);
  if (!order) throw new Error(`Order not found: ${ORDER_ID}`);
  if (order.id !== ORDER_ID) throw new Error(`Refusing unexpected order id ${order.id}`);
  if (order.printJobId !== EXPECTED_EXISTING_PRINT_JOB_ID) {
    throw new Error(`Refusing: expected existing printJobId=${EXPECTED_EXISTING_PRINT_JOB_ID}, got ${order.printJobId ?? 'null'}`);
  }
  if (!order.pageArtifacts || order.pageArtifacts.length !== 24) {
    throw new Error(`Refusing: expected 24 pageArtifacts, got ${order.pageArtifacts?.length ?? 0}`);
  }

  const now = new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'tmp', 'lukas-final-cover-package', stamp);
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, 'qa'), { recursive: true });

  const front = await readChecked(FRONT_COVER_FILE, FRONT_COVER_EXPECTED_MD5);
  const back = await readChecked(BACK_COVER_FILE, BACK_COVER_EXPECTED_MD5);

  const frontCoverUrl = await putBlob(`orders/${ORDER_ID}/final-cover-package/front-cover-illustrated-2026-05-06.png`, front.buffer, 'image/png', apply, token);
  const backCoverUrl = await putBlob(`orders/${ORDER_ID}/final-cover-package/back-cover-illustrated-2026-05-06.png`, back.buffer, 'image/png', apply, token);

  const story = buildStory(order);
  const imageUrls = [frontCoverUrl, ...order.pageArtifacts.slice().sort((a, b) => a.pageIndex - b.pageIndex).map((p) => p.currentImageUrl)];

  // In dry-run mode, use local file:// URLs because the uploaded blob URLs do not exist yet.
  const buildFrontUrl = apply ? frontCoverUrl : `file://${FRONT_COVER_FILE}`;
  const buildBackUrl = apply ? backCoverUrl : `file://${BACK_COVER_FILE}`;
  const buildImageUrls = [buildFrontUrl, ...imageUrls.slice(1)];

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.startsWith('file://') || u.startsWith('/')) {
      const p = u.startsWith('file://') ? u.slice('file://'.length) : u;
      return new Response(await readFile(p), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return realFetch(input, init);
  };

  const proofPdf = await buildPdf(story, order, buildImageUrls, {
    backCoverUrl: buildBackUrl,
    backCoverTagline: BACK_COVER_BLURB,
  });
  const coverPdf = await buildPrintCoverPdf(1200, 650, story.title, order, {
    frontCoverUrl: buildFrontUrl,
    backCoverUrl: buildBackUrl,
    backCoverTagline: BACK_COVER_BLURB,
  });

  const proofDigest = md5(proofPdf);
  const coverDigest = md5(coverPdf);
  const proofPath = path.join(outDir, 'lukas-final-cover-package-proof-local.pdf');
  const coverPath = path.join(outDir, 'lukas-final-cover-package-cover-local.pdf');
  await writeFile(proofPath, proofPdf);
  await writeFile(coverPath, coverPdf);
  await copyFile(FRONT_COVER_FILE, path.join(outDir, 'qa', 'front-cover-illustrated.png'));
  await copyFile(BACK_COVER_FILE, path.join(outDir, 'qa', 'back-cover-illustrated.png'));

  const proofUrl = await putBlob(`orders/${ORDER_ID}/lukas-final-cover-package-proof-2026-05-06-canonical.pdf`, proofPdf, 'application/pdf', apply, token);
  const coverUrl = await putBlob(`orders/${ORDER_ID}/lukas-final-cover-package-cover-2026-05-06-canonical.pdf`, coverPdf, 'application/pdf', apply, token);

  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: proofUrl,
    printCoverArtifactUrl: coverUrl,
    printCoverMd5: coverDigest,
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_final_illustrated_cover_package_no_lulu',
        meta: {
          frontCoverUrl,
          frontCoverMd5: front.digest,
          backCoverUrl,
          backCoverMd5: back.digest,
          proofUrl,
          proofMd5: proofDigest,
          coverUrl,
          coverMd5: coverDigest,
          proofLocal: proofPath,
          coverLocal: coverPath,
          backCoverBlurb: BACK_COVER_BLURB,
          preservedPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          preservedPrintInteriorArtifactUrl: order.printInteriorArtifactUrl ?? null,
          preservedPrintInteriorMd5: order.printInteriorMd5 ?? null,
          noLuluAction: true,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-final-cover-package-${stamp}.json`);

  const manifest = {
    apply,
    orderId: ORDER_ID,
    generatedAt: now,
    sourceAssets: {
      frontCover: { path: FRONT_COVER_FILE, md5: front.digest, url: frontCoverUrl },
      backCover: { path: BACK_COVER_FILE, md5: back.digest, url: backCoverUrl },
    },
    outputs: {
      proof: { path: proofPath, md5: proofDigest, bytes: proofPdf.length, url: proofUrl },
      cover: { path: coverPath, md5: coverDigest, bytes: coverPdf.length, url: coverUrl },
    },
    old: {
      storyArtifactUrl: order.storyArtifactUrl,
      printCoverArtifactUrl: order.printCoverArtifactUrl,
      printCoverMd5: order.printCoverMd5,
      printInteriorArtifactUrl: order.printInteriorArtifactUrl,
      printInteriorMd5: order.printInteriorMd5,
      reviewStatus: order.reviewStatus,
      proofReviewedAt: order.proofReviewedAt,
      printJobId: order.printJobId,
    },
    next: {
      storyArtifactUrl: updated.storyArtifactUrl,
      printCoverArtifactUrl: updated.printCoverArtifactUrl,
      printCoverMd5: updated.printCoverMd5,
      printInteriorArtifactUrl: updated.printInteriorArtifactUrl,
      printInteriorMd5: updated.printInteriorMd5,
      reviewStatus: updated.reviewStatus,
      proofReviewedAt: updated.proofReviewedAt,
      printJobId: updated.printJobId,
    },
    backupPath,
    backCoverBlurb: BACK_COVER_BLURB,
    notes: [
      'Reused existing illustrated front/back cover art; no whole-book regeneration.',
      'Rebuilt proof PDF and print cover PDF with illustrated front/back and personalized back-cover blurb.',
      'Preserved current order status flow, existing printJobId, and current print interior artifact.',
      'No Lulu submission, payment, cancellation, or fulfillment API call performed.',
    ],
  };
  await writeFile(path.join(outDir, 'final-cover-package-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const html = `<!doctype html><meta charset="utf-8"><title>Lukas final cover package QA</title>
<style>body{font-family:system-ui;background:#151515;color:#eee;margin:24px}.row{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}figure{background:#222;padding:10px;border-radius:10px;margin:0}img{width:100%;height:auto;border-radius:6px}figcaption{color:#ccc;font-size:13px;margin-top:8px}.blurb{background:#272018;padding:16px;border-radius:10px;line-height:1.5}</style>
<h1>Lukas final illustrated cover package</h1>
<p>Order ${ORDER_ID}. Generated ${now}. No Lulu action.</p>
<div class="row"><figure><img src="qa/front-cover-illustrated.png"><figcaption>Front cover source — md5 ${front.digest}</figcaption></figure><figure><img src="qa/back-cover-illustrated.png"><figcaption>Back cover source — md5 ${back.digest}</figcaption></figure></div>
<h2>Back-cover blurb</h2><p class="blurb">${BACK_COVER_BLURB}</p>
<ul><li><a href="lukas-final-cover-package-proof-local.pdf">Proof PDF</a> — ${proofDigest}</li><li><a href="lukas-final-cover-package-cover-local.pdf">Print cover PDF</a> — ${coverDigest}</li></ul>`;
  await writeFile(path.join(outDir, 'qa-contact-sheet.html'), html, 'utf8');

  console.log(JSON.stringify(manifest, null, 2));

  if (!apply) {
    console.log('[promote-lukas-final-cover-package] dry-run only; pass --apply to upload and persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[promote-lukas-final-cover-package] applied; no Lulu action performed.');
}

main().catch((error) => {
  console.error('[promote-lukas-final-cover-package] failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
