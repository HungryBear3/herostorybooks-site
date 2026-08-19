import crypto from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';

import {
  OrderPersistenceError,
  OrderVersionConflictError,
  appendAuditEventTo,
  applyFulfillmentPatchTo,
  readOrderVersioned,
  withOrderTransaction,
} from './orders.ts';
import type { OrderRecord, PrivateArtifactMetadata } from './orders.ts';
import { buildHashedReviewCapabilityPatch, privateReviewPathFor } from './review-capability.ts';

export const ORD217_PINS = {
  orderId: ['ord', '217450cb153f4543'].join('_'),
  pdfSha256: 'bfbad60c2340916a75bb9ae4a1b67a1e46ca08423c2f664980c3cddfd8146ea6',
  pdfBytes: 27510520,
  manifestSha256: '567f2fdd6aea68bba45c1e5e0c0bee42e543f3091e344b6569585a7ebe2be0d7',
  zipSha256: '0ccfd9cfbb8e4c2c54019c8b2f8f7ce95bde57828a6d290694c7df2ef238311f',
  sha256sumsSha256: 'e6c8c98529eca60e64d057ee2278f8e58d994003522663062eea0145f0697ba9',
  sourceCommit: 'b94a97dcf2bd3dde076ab38347d2abf079ec5e2a',
} as const;

export interface Ord217Approval {
  orderId: string;
  sourceCommit: string;
  pdfSha256: string;
  pdfBytes: number;
  manifestSha256: string;
  zipSha256: string;
  sha256sumsSha256: string;
  operator: string;
  expiresAt: string;
  maxOrderCasCommits: number;
  allowCustomerSend: boolean;
  allowPrintProvider: boolean;
  allowPaymentMutation: boolean;
  allowRefund: boolean;
  allowDeploy: boolean;
  allowDelete: boolean;
}

export interface Ord217ApprovedManifestRow {
  storyPage: number;
  pdfPage: number;
  assetId: string;
  fileName?: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface Ord217ApprovedManifest {
  rows: Ord217ApprovedManifestRow[];
}

export interface Ord217PageInput {
  storyPage: number;
  pdfPage: number;
  assetId: string;
  contentType: string;
  bytes: number;
  sha256: string;
  body: Uint8Array | Buffer;
  storyText: string;
  basePrompt: string;
}

export interface Ord217ProofInput {
  contentType: 'application/pdf';
  bytes: number;
  sha256: string;
  body: Uint8Array | Buffer;
}

export interface Ord217StripeFacts {
  sessionId: string;
  paid: boolean;
  refunded: boolean;
  disputed: boolean;
  livemode: boolean;
  amountCents: number;
  product: 'digital' | string;
}

export interface Ord217AttachInput {
  mode: 'preflight' | 'execute';
  env: { HSB_PRIVATE_READ_WRITE_TOKEN?: string; BLOB_READ_WRITE_TOKEN?: string };
  approval?: Ord217Approval;
  manifest?: Ord217ApprovedManifest;
  proof?: Ord217ProofInput;
  pages: Ord217PageInput[];
  reviewTokenExpiresAt?: string;
  outputFile?: string;
}

export interface Ord217ArtifactCounts {
  created: number;
  reconciled: number;
}

export interface Ord217AttachResult {
  ok: boolean;
  error?: string;
  order?: OrderRecord;
  reviewPath?: string;
  artifacts?: Ord217ArtifactCounts;
}

type PutOutcome =
  | { outcome: 'created'; pathname: string }
  | { outcome: 'already_exists'; pathname: string }
  | { outcome: 'ambiguous'; pathname: string };

interface ReconciledArtifact {
  found: boolean;
  pathname?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string | null;
}

export interface Ord217Deps {
  now?: () => Date;
  readOrderVersioned: (orderId: string) => Promise<{ order: OrderRecord; version: string } | null>;
  readStripeFacts: (order: OrderRecord) => Promise<Ord217StripeFacts>;
  putPrivateArtifact: (spec: {
    kind: 'page' | 'proof';
    pathname: string;
    sha256: string;
    bytes: number;
    contentType: string;
    body: Uint8Array | Buffer;
  }) => Promise<PutOutcome>;
  reconcilePrivateArtifact?: (spec: {
    pathname: string;
    sha256: string;
    bytes: number;
    contentType: string;
  }) => Promise<ReconciledArtifact>;
  withOrderTransaction?: typeof withOrderTransaction<MutationResult>;
  writePermissionedOutput?: (path: string, content: string) => Promise<void>;
}

function shaToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function redactReviewPath(orderId: string): string {
  return privateReviewPathFor(orderId, '[redacted]');
}

function zeroArtifactCounts(): Ord217ArtifactCounts {
  return { created: 0, reconciled: 0 };
}

function normalizeSha256(value: string): string {
  return value.trim().toLowerCase();
}

function resolvePrivateCredential(env: Ord217AttachInput['env']): { ok: true; token: string } | { ok: false; error: string } {
  const privateToken = (env.HSB_PRIVATE_READ_WRITE_TOKEN ?? '').trim();
  const publicToken = (env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!privateToken) return { ok: false, error: 'private_credential_missing' };
  if (publicToken && privateToken === publicToken) return { ok: false, error: 'private_credential_reuses_public_store' };
  return { ok: true, token: privateToken };
}

function validateApproval(approval: Ord217Approval | undefined, now: Date): string | null {
  if (!approval) return 'approval_missing';
  if (approval.orderId !== ORD217_PINS.orderId) return 'approval_order_mismatch';
  if (approval.sourceCommit !== ORD217_PINS.sourceCommit) return 'approval_source_commit_mismatch';
  if (normalizeSha256(approval.pdfSha256) !== ORD217_PINS.pdfSha256 || approval.pdfBytes !== ORD217_PINS.pdfBytes) return 'approval_pdf_mismatch';
  if (normalizeSha256(approval.manifestSha256) !== ORD217_PINS.manifestSha256) return 'approval_manifest_mismatch';
  if (normalizeSha256(approval.zipSha256) !== ORD217_PINS.zipSha256) return 'approval_zip_mismatch';
  if (normalizeSha256(approval.sha256sumsSha256) !== ORD217_PINS.sha256sumsSha256) return 'approval_sha256sums_mismatch';
  if (!approval.operator.trim()) return 'approval_operator_missing';
  if (approval.maxOrderCasCommits !== 1) return 'approval_max_order_cas_commits_mismatch';
  if (
    approval.allowCustomerSend
    || approval.allowPrintProvider
    || approval.allowPaymentMutation
    || approval.allowRefund
    || approval.allowDeploy
    || approval.allowDelete
  ) return 'approval_forbidden_effects_mismatch';
  const expiresMs = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return 'approval_expired';
  return null;
}

function validateManifest(manifest: Ord217ApprovedManifest | undefined): string | null {
  if (!manifest) return 'manifest_missing';
  if (!Array.isArray(manifest.rows) || manifest.rows.length !== 24) return 'manifest_row_count_mismatch';
  const seen = new Set<number>();
  for (const row of manifest.rows) {
    if (!Number.isInteger(row.storyPage) || row.storyPage < 1 || row.storyPage > 24) return 'manifest_story_page_out_of_range';
    if (!Number.isInteger(row.pdfPage) || row.pdfPage !== row.storyPage + 2) return 'manifest_pdf_mapping_mismatch';
    if (seen.has(row.storyPage)) return 'manifest_duplicate_story_page';
    if (row.assetId !== `page-${String(row.storyPage).padStart(2, '0')}`) return 'manifest_asset_id_mismatch';
    if (!/^[a-f0-9]{64}$/.test(normalizeSha256(row.sha256))) return 'manifest_sha_malformed';
    if (!row.contentType || row.bytes <= 0) return 'manifest_metadata_invalid';
    seen.add(row.storyPage);
  }
  for (let i = 1; i <= 24; i += 1) {
    if (!seen.has(i)) return 'manifest_missing_story_page';
  }
  return null;
}

function validateProofInput(proof: Ord217ProofInput | undefined): string | null {
  if (!proof) return 'proof_missing';
  if (!proof.body) return 'proof_body_missing';
  if (proof.contentType !== 'application/pdf') return 'proof_content_type_mismatch';
  if (proof.bytes <= 0) return 'proof_bytes_mismatch';
  if (!/^[a-f0-9]{64}$/.test(normalizeSha256(proof.sha256))) return 'proof_sha256_mismatch';
  const actualBytes = proof.body instanceof Uint8Array ? proof.body : new Uint8Array(proof.body);
  if (actualBytes.byteLength !== proof.bytes) return 'proof_body_bytes_mismatch';
  if (sha256Hex(actualBytes) !== normalizeSha256(proof.sha256)) return 'proof_body_sha256_mismatch';
  return null;
}

function validatePageSetAgainstManifest(
  pages: Ord217PageInput[],
  manifest: Ord217ApprovedManifest,
): string | null {
  if (pages.length !== 24) return 'page_set_count_mismatch';
  const rowsByStoryPage = new Map(manifest.rows.map((row) => [row.storyPage, row]));
  const seen = new Set<number>();
  for (const page of pages) {
    if (!Number.isInteger(page.storyPage) || page.storyPage < 1 || page.storyPage > 24) return 'page_set_story_page_out_of_range';
    if (seen.has(page.storyPage)) return 'page_set_duplicate_story_page';
    const approved = rowsByStoryPage.get(page.storyPage);
    if (!approved) return 'page_set_unapproved_story_page';
    if (page.assetId !== approved.assetId) return 'page_set_manifest_asset_id_mismatch';
    if (page.pdfPage !== approved.pdfPage) return 'page_set_manifest_pdf_mapping_mismatch';
    if (page.contentType !== approved.contentType) return 'page_set_manifest_content_type_mismatch';
    if (page.bytes !== approved.bytes) return 'page_set_manifest_bytes_mismatch';
    if (normalizeSha256(page.sha256) !== normalizeSha256(approved.sha256)) return 'page_set_manifest_sha256_mismatch';
    if (!page.body) return 'page_set_body_missing';
    const bytes = page.body instanceof Uint8Array ? page.body : new Uint8Array(page.body);
    if (bytes.byteLength !== page.bytes) return 'page_set_body_bytes_mismatch';
    if (sha256Hex(bytes) !== normalizeSha256(page.sha256)) return 'page_set_body_sha256_mismatch';
    seen.add(page.storyPage);
  }
  for (let i = 1; i <= 24; i += 1) {
    if (!seen.has(i)) return 'page_set_missing_story_page';
  }
  return null;
}

function validatePrestate(order: OrderRecord, stripeFacts: Ord217StripeFacts): string | null {
  if (order.id !== ORD217_PINS.orderId) return 'prestate_wrong_order';
  if (!order.stripeSessionId || stripeFacts.sessionId !== order.stripeSessionId) return 'prestate_stripe_session_mismatch';
  if (order.paymentStatus !== 'paid' || !stripeFacts.paid) return 'prestate_unpaid';
  if (order.refundedAt || order.stripeRefundId || order.refundClaimId || stripeFacts.refunded) return 'prestate_refunded';
  if (stripeFacts.disputed) return 'prestate_disputed';
  if (!stripeFacts.livemode) return 'prestate_not_live';
  if (stripeFacts.product !== 'digital' || stripeFacts.amountCents !== 1900 || order.settledAmountCents !== 1900) {
    return 'prestate_price_or_product_mismatch';
  }
  if (order.status !== 'order_received') return 'prestate_status_mismatch';
  if ((order.pageArtifacts?.length ?? 0) > 0 || order.storyArtifactUrl || order.privateStoryArtifact) return 'prestate_existing_artifacts';
  if (order.reviewStatus || order.proofApprovalToken || order.proofApprovalTokenHash || order.customerProofReleasedAt) {
    return 'prestate_existing_review_state';
  }
  if (
    order.proofApprovedAt || order.printApprovedAt || order.printSubmittedAt || order.printJobId
    || order.printJobStatus || order.printInteriorArtifactUrl || order.printCoverArtifactUrl
  ) return 'prestate_existing_print_state';
  return null;
}

function proofVersion(): string {
  return `ord217-${ORD217_PINS.pdfSha256.slice(0, 12)}`;
}

function proofSourceFingerprint(): string {
  return `ord217:${ORD217_PINS.manifestSha256}`;
}

function artifactPath(orderId: string, kind: 'page' | 'proof', sha256: string): string {
  return kind === 'proof'
    ? `orders/${orderId}/proofs/${sha256}.pdf`
    : `orders/${orderId}/pages/${sha256}.png`;
}

async function uploadWithCreateOnlyReconciliation(
  spec: {
    kind: 'page' | 'proof';
    pathname: string;
    sha256: string;
    bytes: number;
    contentType: string;
    body: Uint8Array | Buffer;
  },
  deps: Ord217Deps,
): Promise<
  | { ok: true; pathname: string; disposition: 'created' | 'reconciled' }
  | { ok: false; error: string }
> {
  if (!spec.body) return { ok: false, error: spec.kind === 'proof' ? 'proof_body_missing' : 'page_set_body_missing' };
  try {
    const result = await deps.putPrivateArtifact(spec);
    if (result.pathname !== spec.pathname) return { ok: false, error: 'private_upload_pathname_mismatch' };
    if (result.outcome === 'created') return { ok: true, pathname: result.pathname, disposition: 'created' };
    const reconciled = await deps.reconcilePrivateArtifact?.({
      pathname: result.pathname,
      sha256: spec.sha256,
      bytes: spec.bytes,
      contentType: spec.contentType,
    });
    if (
      reconciled?.found
      && reconciled.pathname === spec.pathname
      && normalizeSha256(reconciled.sha256 ?? '') === normalizeSha256(spec.sha256)
      && reconciled.bytes === spec.bytes
      && (reconciled.contentType ?? null) === spec.contentType
    ) {
      return { ok: true, pathname: result.pathname, disposition: 'reconciled' };
    }
    return { ok: false, error: 'private_upload_reconciliation_failed' };
  } catch {
    return { ok: false, error: 'private_upload_failed' };
  }
}

async function writePermissionedOutput(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

type MutationResult =
  | { ok: true; order: OrderRecord }
  | { ok: false; error: string };

function resultError(error: string, artifacts: Ord217ArtifactCounts): Ord217AttachResult {
  return { ok: false, error, artifacts };
}

export async function runOrd217PrivateReviewAttachment(
  input: Ord217AttachInput,
  deps: Ord217Deps,
): Promise<Ord217AttachResult> {
  const artifacts = zeroArtifactCounts();
  const credential = resolvePrivateCredential(input.env);
  if (credential.ok === false) return resultError(credential.error, artifacts);

  const now = (deps.now ?? (() => new Date()))();
  const approvalError = validateApproval(input.approval, now);
  if (approvalError) return resultError(approvalError, artifacts);
  const manifestError = validateManifest(input.manifest);
  if (manifestError) return resultError(manifestError, artifacts);
  const proofError = validateProofInput(input.proof);
  if (proofError) return resultError(proofError, artifacts);
  const pageSetError = validatePageSetAgainstManifest(input.pages, input.manifest!);
  if (pageSetError) return resultError(pageSetError, artifacts);

  const current = await deps.readOrderVersioned(ORD217_PINS.orderId);
  if (!current) return resultError('order_not_found', artifacts);

  const stripeFacts = await deps.readStripeFacts(current.order);
  const prestateError = validatePrestate(current.order, stripeFacts);
  if (prestateError) return resultError(prestateError, artifacts);

  if (input.mode === 'preflight') {
    return {
      ok: true,
      reviewPath: redactReviewPath(ORD217_PINS.orderId),
      artifacts,
    };
  }

  const createdAt = now.toISOString();
  const retentionUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const uploadedPages: Array<{ page: Ord217PageInput; meta: PrivateArtifactMetadata }> = [];
  for (const page of input.pages) {
    const upload = await uploadWithCreateOnlyReconciliation({
      kind: 'page',
      pathname: artifactPath(ORD217_PINS.orderId, 'page', normalizeSha256(page.sha256)),
      sha256: normalizeSha256(page.sha256),
      bytes: page.bytes,
      contentType: page.contentType,
      body: page.body,
    }, deps);
    if (upload.ok === false) return resultError(upload.error, artifacts);
    artifacts[upload.disposition] += 1;
    uploadedPages.push({
      page,
      meta: {
        pathname: upload.pathname,
        sha256: normalizeSha256(page.sha256),
        bytes: page.bytes,
        contentType: page.contentType,
        createdAt,
        retentionUntil,
      },
    });
  }

  const proofUpload = await uploadWithCreateOnlyReconciliation({
    kind: 'proof',
    pathname: artifactPath(ORD217_PINS.orderId, 'proof', ORD217_PINS.pdfSha256),
    sha256: ORD217_PINS.pdfSha256,
    bytes: ORD217_PINS.pdfBytes,
    contentType: 'application/pdf',
    body: input.proof!.body,
  }, deps);
  if (proofUpload.ok === false) return resultError(proofUpload.error, artifacts);
  artifacts[proofUpload.disposition] += 1;

  const approvalStillValid = validateApproval(input.approval, (deps.now ?? (() => new Date()))());
  if (approvalStillValid) return resultError(approvalStillValid, artifacts);
  const freshStripeFacts = await deps.readStripeFacts(current.order);
  const freshPrestateError = validatePrestate(current.order, freshStripeFacts);
  if (freshPrestateError) return resultError(freshPrestateError, artifacts);

  const reviewToken = shaToken();
  const reviewTokenExpiresAt = input.reviewTokenExpiresAt ?? input.approval!.expiresAt;
  const transaction = deps.withOrderTransaction ?? withOrderTransaction<MutationResult>;

  try {
    const mutation = await transaction(
      ORD217_PINS.orderId,
      async (authoritative) => {
        const approvalErrorInsideCas = validateApproval(input.approval, (deps.now ?? (() => new Date()))());
        if (approvalErrorInsideCas) return { abort: { ok: false, error: approvalErrorInsideCas } };
        const authoritativeStripeFacts = await deps.readStripeFacts(authoritative);
        const latestPrestateError = validatePrestate(authoritative, authoritativeStripeFacts);
        if (latestPrestateError) return { abort: { ok: false, error: latestPrestateError } };

        let next = applyFulfillmentPatchTo(authoritative, {
          storyArtifactUrl: `/api/order/${ORD217_PINS.orderId}/review-asset/proof-pdf`,
          privateStoryArtifact: {
            pathname: proofUpload.pathname,
            sha256: ORD217_PINS.pdfSha256,
            bytes: ORD217_PINS.pdfBytes,
            contentType: 'application/pdf',
            createdAt,
            retentionUntil,
          },
          pageArtifacts: uploadedPages.map(({ page, meta }) => ({
            pageIndex: page.storyPage - 1,
            storyText: page.storyText,
            basePrompt: page.basePrompt,
            currentImageUrl: `/api/order/${ORD217_PINS.orderId}/review-asset/${page.assetId}`,
            acceptedImageUrl: null,
            accepted: false,
            regenerateCount: 0,
            feedbackHistory: [],
            versionHistory: [],
            privateReviewAsset: meta,
          })),
          reviewStatus: 'in_review',
          proofApprovalToken: null,
          ...buildHashedReviewCapabilityPatch(reviewToken, reviewTokenExpiresAt),
          proofSourceFingerprint: proofSourceFingerprint(),
          proofVersion: proofVersion(),
          proofReviewedAt: null,
          proofReviewedVersion: null,
        }, createdAt);
        next = appendAuditEventTo(next, {
          type: 'review_link_prepared',
          reason: 'ord217_private_review_attached',
          meta: {
            operator: input.approval!.operator.trim(),
            proofVersion: proofVersion(),
            privateFlow: true,
            createdArtifacts: artifacts.created,
            reconciledArtifacts: artifacts.reconciled,
          },
        }, createdAt);
        return { commit: next, result: { ok: true, order: next } };
      },
      { maxAttempts: 1 },
    );
    if (mutation.ok === false) return resultError(mutation.error, artifacts);
    if (input.outputFile) {
      await (deps.writePermissionedOutput ?? writePermissionedOutput)(
        input.outputFile,
        `${privateReviewPathFor(ORD217_PINS.orderId, reviewToken)}\n`,
      );
    }
    return {
      ok: true,
      order: mutation.order,
      reviewPath: redactReviewPath(ORD217_PINS.orderId),
      artifacts,
    };
  } catch (error) {
    if (error instanceof OrderVersionConflictError) return resultError('hold_order_cas_conflict', artifacts);
    if (error instanceof OrderPersistenceError && /Order not found for guarded commit/.test(error.message)) {
      return resultError('order_not_found', artifacts);
    }
    throw error;
  }
}

export const ord217DefaultDeps = {
  readOrderVersioned,
  withOrderTransaction,
};
