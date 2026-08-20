import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, stat } from 'node:fs/promises';

import { get, put } from '@vercel/blob';

import {
  ORD217_PINS,
  ord217DefaultDeps,
  runOrd217PrivateReviewAttachment,
  type Ord217Approval,
  type Ord217ApprovedManifest,
  type Ord217ApprovedManifestRow,
  type Ord217PageInput,
  type Ord217ProofInput,
  type Ord217StripeFacts,
} from '../src/lib/ord217-private-review.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { getOptionalStripeSecretKey } from '../src/lib/stripe-env.ts';

interface CliArgs {
  execute: boolean;
  pdfPath: string;
  manifestPath: string;
  sha256sumsPath: string;
  evidenceZipPath: string;
  rendersDir: string;
  approvalPath: string;
  outputPath?: string;
}

interface CliSummary {
  ok: boolean;
  error: string | null;
  reviewPath: string | null;
  orderId: string;
  artifacts: { created: number; reconciled: number };
}

interface CliDeps {
  readOrderVersioned?: typeof ord217DefaultDeps.readOrderVersioned;
  withOrderTransaction?: typeof ord217DefaultDeps.withOrderTransaction;
  readStripeFacts?: (order: OrderRecord) => Promise<Ord217StripeFacts>;
  putPrivateArtifact?: Parameters<typeof runOrd217PrivateReviewAttachment>[1]['putPrivateArtifact'];
  reconcilePrivateArtifact?: Parameters<typeof runOrd217PrivateReviewAttachment>[1]['reconcilePrivateArtifact'];
}

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sanitizeError(message: string): string {
  return message.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

function requireFlag(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  const value = idx >= 0 ? (args[idx + 1] ?? '') : '';
  if (!value || value.startsWith('--')) throw new Error(`missing_${flag.slice(2)}_path`);
  return value;
}

export function parseCliArgs(argv: string[]): CliArgs {
  return {
    execute: argv.includes('--execute'),
    pdfPath: requireFlag(argv, '--pdf'),
    manifestPath: requireFlag(argv, '--manifest'),
    sha256sumsPath: requireFlag(argv, '--sha256sums'),
    evidenceZipPath: requireFlag(argv, '--evidence-zip'),
    rendersDir: requireFlag(argv, '--renders-dir'),
    approvalPath: requireFlag(argv, '--approval'),
    outputPath: argv.includes('--output') ? requireFlag(argv, '--output') : undefined,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function normalizeSha(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function integerField(row: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

function stringField(row: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function manifestRowsFromUnknown(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
  if (input && typeof input === 'object') {
    const rows = (input as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
    }
  }
  throw new Error('manifest_rows_invalid');
}

export function parseApprovedManifest(input: unknown): {
  manifest: Ord217ApprovedManifest;
  pageScaffold: Array<Pick<Ord217PageInput, 'storyPage' | 'pdfPage' | 'assetId' | 'contentType' | 'bytes' | 'sha256' | 'storyText' | 'basePrompt'> & { fileName: string }>;
} {
  const parsedRows = manifestRowsFromUnknown(input);
  const rows: Ord217ApprovedManifestRow[] = [];
  const pageScaffold: Array<Pick<Ord217PageInput, 'storyPage' | 'pdfPage' | 'assetId' | 'contentType' | 'bytes' | 'sha256' | 'storyText' | 'basePrompt'> & { fileName: string }> = [];
  for (const row of parsedRows) {
    const storyPage = integerField(row, ['storyPage', 'story_page']);
    const pdfPage = integerField(row, ['pdfPage', 'pdf_page']);
    const bytes = integerField(row, ['bytes', 'size', 'byteLength']);
    const contentType = stringField(row, ['contentType', 'content_type', 'mimeType', 'mime_type']);
    const sha256 = normalizeSha(row.sha256 ?? row.hash ?? row.sha);
    const fileName = stringField(row, ['fileName', 'filename', 'file', 'path', 'renderFile', 'render_file']);
    const storyText = stringField(row, ['storyText', 'story_text']) ?? '';
    const basePrompt = stringField(row, ['basePrompt', 'base_prompt']) ?? '';
    if (!storyPage || !pdfPage || !bytes || !contentType || !sha256 || !fileName) throw new Error('manifest_row_fields_invalid');
    const assetId = `page-${String(storyPage).padStart(2, '0')}`;
    rows.push({
      storyPage,
      pdfPage,
      assetId,
      fileName: path.basename(fileName),
      contentType,
      bytes,
      sha256,
    });
    pageScaffold.push({
      storyPage,
      pdfPage,
      assetId,
      contentType,
      bytes,
      sha256,
      storyText,
      basePrompt,
      fileName: path.basename(fileName),
    });
  }
  return { manifest: { rows }, pageScaffold };
}

export function parseApprovedManifestDocument(text: string): ReturnType<typeof parseApprovedManifest> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseApprovedManifest(JSON.parse(trimmed) as unknown);
  }

  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*\|\s*`([a-fA-F0-9]{64})`\s*\|$/);
    if (!match) continue;
    rows.push({
      storyPage: Number(match[1]),
      pdfPage: Number(match[2]),
      fileName: match[3],
      bytes: Number(match[4].replaceAll(',', '')),
      sha256: match[5].toLowerCase(),
      contentType: 'image/png',
    });
  }
  if (rows.length !== 24) throw new Error('manifest_markdown_row_count_mismatch');
  return parseApprovedManifest({ rows });
}

async function loadPinnedFile(filePath: string, expectedSha256: string, expectedBytes?: number): Promise<Buffer> {
  const body = await readFile(filePath);
  if (typeof expectedBytes === 'number' && body.byteLength !== expectedBytes) throw new Error(`${path.basename(filePath)}_bytes_mismatch`);
  if (sha256Hex(body) !== expectedSha256) throw new Error(`${path.basename(filePath)}_sha256_mismatch`);
  return body;
}

async function loadPageInputs(
  rendersDir: string,
  pageScaffold: Array<Pick<Ord217PageInput, 'storyPage' | 'pdfPage' | 'assetId' | 'contentType' | 'bytes' | 'sha256' | 'storyText' | 'basePrompt'> & { fileName: string }>,
): Promise<Ord217PageInput[]> {
  const dirEntries = new Set(await readdir(rendersDir));
  const pages: Ord217PageInput[] = [];
  for (const page of pageScaffold) {
    if (!dirEntries.has(page.fileName)) throw new Error(`render_missing_${page.assetId}`);
    const renderPath = path.join(rendersDir, page.fileName);
    const info = await stat(renderPath);
    if (!info.isFile()) throw new Error(`render_not_file_${page.assetId}`);
    const body = await readFile(renderPath);
    if (body.byteLength !== page.bytes) throw new Error(`render_bytes_mismatch_${page.assetId}`);
    if (sha256Hex(body) !== page.sha256) throw new Error(`render_sha256_mismatch_${page.assetId}`);
    pages.push({
      ...page,
      body,
    });
  }
  return pages.sort((a, b) => a.storyPage - b.storyPage);
}

async function readStripeJson<T>(stripeSecretKey: string, pathname: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`stripe_get_failed_${response.status}_${sanitizeError(body.slice(0, 120))}`);
  }
  return await response.json() as T;
}

async function defaultReadStripeFacts(order: OrderRecord): Promise<Ord217StripeFacts> {
  const stripeSecretKey = getOptionalStripeSecretKey();
  const sessionId = order.stripeSessionId?.trim() ?? '';
  if (!stripeSecretKey) throw new Error('stripe_secret_missing');
  if (!sessionId) throw new Error('stripe_session_missing');

  const session = await readStripeJson<Record<string, unknown>>(
    stripeSecretKey,
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=${encodeURIComponent('payment_intent.latest_charge.dispute')}&expand[]=${encodeURIComponent('payment_intent.charges.data.dispute')}`,
  );

  const paymentIntent = (session.payment_intent && typeof session.payment_intent === 'object')
    ? session.payment_intent as Record<string, unknown>
    : null;
  const latestCharge = (paymentIntent?.latest_charge && typeof paymentIntent.latest_charge === 'object')
    ? paymentIntent.latest_charge as Record<string, unknown>
    : null;
  const firstCharge = Array.isArray((paymentIntent?.charges as { data?: unknown })?.data)
    ? ((paymentIntent?.charges as { data: unknown[] }).data[0] as Record<string, unknown> | undefined)
    : undefined;
  const charge = latestCharge ?? firstCharge ?? null;
  const disputed = Boolean(
    (charge?.dispute && typeof charge.dispute === 'object')
    || (typeof charge?.dispute === 'string' && charge.dispute.trim()),
  );
  const refunded = Boolean(charge?.refunded) || (typeof charge?.amount_refunded === 'number' && charge.amount_refunded > 0);
  const metadata = (session.metadata && typeof session.metadata === 'object') ? session.metadata as Record<string, unknown> : null;

  return {
    sessionId,
    paid: session.payment_status === 'paid',
    refunded,
    disputed,
    livemode: session.livemode === true,
    amountCents: typeof session.amount_total === 'number' ? session.amount_total : 0,
    product: typeof metadata?.bookFormat === 'string' ? metadata.bookFormat : 'unknown',
  };
}

async function defaultPutPrivateArtifact(spec: {
  kind: 'page' | 'proof';
  pathname: string;
  sha256: string;
  bytes: number;
  contentType: string;
  body: Uint8Array | Buffer;
}): Promise<{ outcome: 'created' | 'already_exists' | 'ambiguous'; pathname: string }> {
  const token = (process.env.HSB_PRIVATE_READ_WRITE_TOKEN ?? '').trim();
  if (!token) throw new Error('private_credential_missing');
  try {
    const result = await put(spec.pathname, Buffer.from(spec.body), {
      access: 'private',
      token,
      contentType: spec.contentType,
      allowOverwrite: false,
      addRandomSuffix: false,
    });
    return { outcome: 'created', pathname: result.pathname };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists|exist/i.test(message)) return { outcome: 'already_exists', pathname: spec.pathname };
    return { outcome: 'ambiguous', pathname: spec.pathname };
  }
}

async function defaultReconcilePrivateArtifact(spec: {
  pathname: string;
  sha256: string;
  bytes: number;
  contentType: string;
}): Promise<{ found: boolean; pathname?: string; sha256?: string; bytes?: number; contentType?: string | null }> {
  const token = (process.env.HSB_PRIVATE_READ_WRITE_TOKEN ?? '').trim();
  if (!token) throw new Error('private_credential_missing');
  try {
    const result = await get(spec.pathname, { access: 'private', token, useCache: false });
    const body = Buffer.from(await new Response(result.stream).arrayBuffer());
    return {
      found: true,
      pathname: result.blob.pathname,
      sha256: sha256Hex(body),
      bytes: body.byteLength,
      contentType: result.blob.contentType ?? null,
    };
  } catch {
    return { found: false };
  }
}

export async function runAttachOrd217PrivateReviewCli(argv: string[], deps: CliDeps = {}): Promise<CliSummary> {
  const args = parseCliArgs(argv);

  const approval = await readJsonFile<Ord217Approval>(args.approvalPath);
  const manifestBytes = await loadPinnedFile(args.manifestPath, ORD217_PINS.manifestSha256);
  const pdfBytes = await loadPinnedFile(args.pdfPath, ORD217_PINS.pdfSha256, ORD217_PINS.pdfBytes);
  await loadPinnedFile(args.sha256sumsPath, ORD217_PINS.sha256sumsSha256);
  await loadPinnedFile(args.evidenceZipPath, ORD217_PINS.zipSha256);

  if (normalizeSha(approval.manifestSha256) !== ORD217_PINS.manifestSha256) throw new Error('approval_manifest_mismatch');
  if (normalizeSha(approval.pdfSha256) !== ORD217_PINS.pdfSha256 || approval.pdfBytes !== ORD217_PINS.pdfBytes) {
    throw new Error('approval_pdf_mismatch');
  }
  if (normalizeSha(approval.sha256sumsSha256) !== ORD217_PINS.sha256sumsSha256) throw new Error('approval_sha256sums_mismatch');
  if (normalizeSha(approval.zipSha256) !== ORD217_PINS.zipSha256) throw new Error('approval_zip_mismatch');

  const { manifest, pageScaffold } = parseApprovedManifestDocument(manifestBytes.toString('utf8'));
  const pages = await loadPageInputs(args.rendersDir, pageScaffold);
  const proof: Ord217ProofInput = {
    body: pdfBytes,
    bytes: pdfBytes.byteLength,
    sha256: ORD217_PINS.pdfSha256,
    contentType: 'application/pdf',
  };

  const result = await runOrd217PrivateReviewAttachment(
    {
      mode: args.execute ? 'execute' : 'preflight',
      env: {
        HSB_PRIVATE_READ_WRITE_TOKEN: process.env.HSB_PRIVATE_READ_WRITE_TOKEN,
        BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
      },
      approval,
      manifest,
      proof,
      pages,
      outputFile: args.outputPath,
    },
    {
      now: () => new Date(),
      readOrderVersioned: deps.readOrderVersioned ?? ord217DefaultDeps.readOrderVersioned,
      withOrderTransaction: deps.withOrderTransaction ?? ord217DefaultDeps.withOrderTransaction,
      readStripeFacts: deps.readStripeFacts ?? defaultReadStripeFacts,
      putPrivateArtifact: deps.putPrivateArtifact ?? defaultPutPrivateArtifact,
      reconcilePrivateArtifact: deps.reconcilePrivateArtifact ?? defaultReconcilePrivateArtifact,
    },
  );

  return {
    ok: result.ok,
    error: result.error ?? null,
    reviewPath: result.reviewPath ?? null,
    orderId: ORD217_PINS.orderId,
    artifacts: result.artifacts ?? { created: 0, reconciled: 0 },
  };
}

async function main() {
  const summary = await runAttachOrd217PrivateReviewCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

const entryHref = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;

if (entryHref) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: sanitizeError(message),
      reviewPath: null,
      orderId: ORD217_PINS.orderId,
      artifacts: { created: 0, reconciled: 0 },
    })}\n`);
    process.exitCode = 1;
  });
}
