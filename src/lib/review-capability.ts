import crypto from 'node:crypto';

import type { OrderRecord } from './orders.ts';

export const PRIVATE_REVIEW_SESSION_COOKIE_PREFIX = '__Host-hsb_review_session_';
export const PRIVATE_REVIEW_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function timingSafeHexMatch(expectedHex: string, candidateHex: string): boolean {
  if (!expectedHex || !candidateHex || expectedHex.length !== candidateHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(candidateHex, 'utf8'));
  } catch {
    return false;
  }
}

function timingSafeTokenMatch(expected: string, candidate: string): boolean {
  if (!expected || !candidate || expected.length !== candidate.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(candidate, 'utf8'));
  } catch {
    return false;
  }
}

export function buildHashedReviewCapabilityPatch(token: string, expiresAt: string): Pick<
  OrderRecord,
  'proofApprovalTokenHash' | 'proofApprovalTokenExpiresAt'
> {
  return {
    proofApprovalTokenHash: sha256Hex(token),
    proofApprovalTokenExpiresAt: expiresAt,
  };
}

export function getPrivateReviewSessionCookieName(orderId: string): string {
  return `${PRIVATE_REVIEW_SESSION_COOKIE_PREFIX}${orderId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

export function privateReviewPathFor(orderId: string, token: string): string {
  return `/review/${orderId}#token=${token}`;
}

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (const part of (cookieHeader ?? '').split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      result[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
    }
  } catch {
    return {};
  }
  return result;
}

export function getReviewSessionTokenFromCookie(cookieHeader: string | null | undefined, orderId: string): string | null {
  const cookies = parseCookieHeader(cookieHeader);
  return cookies[getPrivateReviewSessionCookieName(orderId)] ?? null;
}

export function getReviewTokenFromRequest(request: Request, orderId: string): string | null {
  const urlToken = new URL(request.url).searchParams.get('token');
  if (urlToken) return urlToken;
  return getReviewSessionTokenFromCookie(request.headers.get('cookie'), orderId);
}

export function hasAnyReviewCapability(order: OrderRecord): boolean {
  return Boolean(order.proofApprovalToken || order.proofApprovalTokenHash);
}

export function hasReviewCapability(order: OrderRecord, token: string | null | undefined, now: Date = new Date()): boolean {
  const presented = token ?? '';
  const storedHash = order.proofApprovalTokenHash ?? '';
  const expiresAt = order.proofApprovalTokenExpiresAt ?? '';
  if (storedHash) {
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) return false;
    return timingSafeHexMatch(storedHash, sha256Hex(presented));
  }
  const storedLegacy = order.proofApprovalToken ?? '';
  if (!storedLegacy) return false;
  return timingSafeTokenMatch(storedLegacy, presented);
}

export function buildPrivateReviewSessionCookie(
  orderId: string,
  token: string,
  now: Date,
  expiresAt?: string | null,
): string {
  const cookieExpiresAt = (() => {
    const maxExpiry = new Date(now.getTime() + PRIVATE_REVIEW_SESSION_MAX_AGE_SECONDS * 1000);
    const bound = expiresAt ? new Date(expiresAt) : null;
    if (bound && Number.isFinite(bound.getTime()) && bound.getTime() < maxExpiry.getTime()) return bound;
    return maxExpiry;
  })();
  return [
    `${getPrivateReviewSessionCookieName(orderId)}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${cookieExpiresAt.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((cookieExpiresAt.getTime() - now.getTime()) / 1000))}`,
  ].join('; ');
}
