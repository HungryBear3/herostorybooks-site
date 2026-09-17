/**
 * GET /api/admin/orders/[orderId]/intake-assets/[assetId]
 *
 * Admin-authenticated, order-scoped retrieval of one private checkout-intake
 * asset's bytes. Every decision — the admin session check, the exact order
 * binding, the storage credential, the provider verification and the response
 * headers — lives in `handleAdminIntakeAssetRequest`. This file is a shell on
 * purpose: a second, weaker copy of any of those rules here is exactly the
 * regression the wiring test forbids.
 */
import { NextResponse } from 'next/server';

import {
  adminIntakeAssetOptionsReply,
  adminIntakeAssetUnsupportedMethodReply,
  handleAdminIntakeAssetRequest,
  type AdminIntakeAssetReply,
} from '@/lib/admin-intake-asset-route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toNextResponse(reply: AdminIntakeAssetReply) {
  if (reply.body === null || reply.body instanceof Uint8Array) {
    return new NextResponse(reply.body as BodyInit | null, {
      status: reply.status,
      headers: reply.headers,
    });
  }
  return NextResponse.json(reply.body, { status: reply.status, headers: reply.headers });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string; assetId: string }> },
) {
  const { orderId, assetId } = await context.params;
  const reply = await handleAdminIntakeAssetRequest(request, orderId, assetId);
  return toNextResponse(reply);
}

export function POST() {
  return toNextResponse(adminIntakeAssetUnsupportedMethodReply());
}

export function OPTIONS() {
  return toNextResponse(adminIntakeAssetOptionsReply());
}
