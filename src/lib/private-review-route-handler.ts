import crypto from 'node:crypto';

import { get } from '@vercel/blob';

import { readOrderVersioned } from './orders.ts';
import type { OrderRecord, PrivateArtifactMetadata } from './orders.ts';
import {
  buildPrivateReviewSessionCookie,
  getReviewTokenFromRequest,
  hasReviewCapability,
} from './review-capability.ts';

export interface RouteReply {
  status: number;
  body: Record<string, unknown> | Uint8Array;
  headers: Record<string, string>;
}

export interface PrivateBlobReadResult {
  pathname: string;
  contentType: string | null;
  body: Uint8Array | Buffer;
}

export const PRIVATE_REVIEW_RETENTION_DAYS = 30;

function notFound(): RouteReply {
  return {
    status: 404,
    body: { error: 'Not found' },
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  };
}

function privateReviewHeaders(contentType?: string, bytes?: number): Record<string, string> {
  return {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(typeof bytes === 'number' ? { 'Content-Length': String(bytes) } : {}),
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  };
}

function sha256HexSync(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isValidAssetId(assetId: string): boolean {
  return assetId === 'proof-pdf' || /^page-\d{2}$/.test(assetId);
}

function hasAttachedPrivateReviewArtifacts(order: OrderRecord): boolean {
  if (!order.privateStoryArtifact || !order.storyArtifactUrl) return false;
  if (!order.pageArtifacts?.length) return false;
  return order.pageArtifacts.every((page, index) => {
    const expectedAssetId = `page-${String(index + 1).padStart(2, '0')}`;
    return Boolean(
      page.privateReviewAsset
      && page.currentImageUrl === `/api/order/${order.id}/review-asset/${expectedAssetId}`,
    );
  });
}

function findPrivateAsset(order: OrderRecord, assetId: string): PrivateArtifactMetadata | null {
  if (assetId === 'proof-pdf') return order.privateStoryArtifact ?? null;
  const pageNumber = Number(assetId.slice('page-'.length));
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  return order.pageArtifacts?.find((page) => page.pageIndex === pageNumber - 1)?.privateReviewAsset ?? null;
}

function requirePrivateReviewToken(): string {
  const privateToken = (process.env.HSB_PRIVATE_READ_WRITE_TOKEN ?? '').trim();
  const publicToken = (process.env.BLOB_READ_WRITE_TOKEN ?? '').trim();
  if (!privateToken) throw new Error('HSB_PRIVATE_READ_WRITE_TOKEN is required');
  if (publicToken && privateToken === publicToken) throw new Error('HSB_PRIVATE_READ_WRITE_TOKEN must differ from BLOB_READ_WRITE_TOKEN');
  return privateToken;
}

function isValidPrivatePathname(orderId: string, pathname: string): boolean {
  if (!pathname) return false;
  if (pathname.startsWith('/')) return false;
  if (pathname.includes('..')) return false;
  if (!pathname.startsWith(`orders/${orderId}/`)) return false;
  return true;
}

export async function handlePrivateReviewSessionRequest(
  request: Request,
  orderId: string,
  deps: {
    now?: () => Date;
    readOrderVersionedImpl?: typeof readOrderVersioned;
  } = {},
): Promise<RouteReply> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json_body' }, headers: privateReviewHeaders('application/json') };
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) {
    return { status: 403, body: { ok: false, error: 'invalid_or_missing_token' }, headers: privateReviewHeaders('application/json') };
  }
  const versioned = await (deps.readOrderVersionedImpl ?? readOrderVersioned)(orderId);
  const order = versioned?.order;
  const now = (deps.now ?? (() => new Date()))();
  if (
    !order
    || order.paymentStatus !== 'paid'
    || Boolean(order.refundedAt || order.stripeRefundId || order.refundClaimId)
    || !hasAttachedPrivateReviewArtifacts(order)
    || !hasReviewCapability(order, token, now)
  ) {
    return { status: 403, body: { ok: false, error: 'invalid_or_missing_token' }, headers: privateReviewHeaders('application/json') };
  }
  return {
    status: 200,
    body: { ok: true },
    headers: {
      ...privateReviewHeaders('application/json'),
      'Set-Cookie': buildPrivateReviewSessionCookie(orderId, token, now, order.proofApprovalTokenExpiresAt ?? null),
    },
  };
}

export async function handlePrivateReviewAssetRequest(
  request: Request,
  orderId: string,
  assetId: string,
  deps: {
    now?: () => Date;
    readOrderVersionedImpl?: typeof readOrderVersioned;
    getPrivateBlob?: (pathname: string, token: string) => Promise<PrivateBlobReadResult>;
  } = {},
): Promise<RouteReply> {
  if (!isValidAssetId(assetId)) return notFound();
  const versioned = await (deps.readOrderVersionedImpl ?? readOrderVersioned)(orderId);
  const order = versioned?.order;
  const reviewToken = getReviewTokenFromRequest(request, orderId);
  const now = (deps.now ?? (() => new Date()))();
  if (!order || !hasAttachedPrivateReviewArtifacts(order)) return notFound();
  if (order.paymentStatus !== 'paid' || order.refundedAt || order.stripeRefundId || order.refundClaimId) return notFound();
  if (!hasReviewCapability(order, reviewToken, now)) return notFound();
  const asset = findPrivateAsset(order, assetId);
  if (!asset || !asset.pathname || !asset.sha256 || !asset.bytes || !asset.contentType) return notFound();
  if (!isValidPrivatePathname(orderId, asset.pathname)) return notFound();

  const token = requirePrivateReviewToken();
  const getPrivateBlob = deps.getPrivateBlob ?? (async (pathname, privateToken) => {
    const result = await get(pathname, { access: 'private', token: privateToken, useCache: false });
    return {
      pathname: result.blob.pathname,
      contentType: result.blob.contentType ?? null,
      body: new Uint8Array(await new Response(result.stream).arrayBuffer()),
    };
  });

  let upstream: PrivateBlobReadResult;
  try {
    upstream = await getPrivateBlob(asset.pathname, token);
  } catch {
    return notFound();
  }
  const bytes = upstream.body instanceof Uint8Array ? upstream.body : new Uint8Array(upstream.body);
  if (upstream.pathname !== asset.pathname) return notFound();
  if (!isValidPrivatePathname(orderId, upstream.pathname)) return notFound();
  if ((upstream.contentType ?? asset.contentType) !== asset.contentType) return notFound();
  if (bytes.byteLength !== asset.bytes) return notFound();
  if (sha256HexSync(bytes) !== asset.sha256) return notFound();
  return {
    status: 200,
    body: bytes,
    headers: privateReviewHeaders(asset.contentType, asset.bytes),
  };
}
