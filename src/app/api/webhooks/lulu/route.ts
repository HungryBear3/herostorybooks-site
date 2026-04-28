import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

import { applyLuluStatusUpdate, type LuluWebhookPayload } from '@/lib/admin-actions';
import { listOrders } from '@/lib/orders';

export const dynamic = 'force-dynamic';

function verifyHmac(body: string, headerSig: string | null, secret: string): boolean {
  if (!headerSig) return false;
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(headerSig));
  } catch {
    return false;
  }
}

async function resolveOrderByJobId(jobId: string): Promise<string | null> {
  const all = await listOrders();
  const match = all.find(o => o.printJobId === jobId);
  return match?.id ?? null;
}

export async function POST(request: Request) {
  const secret = process.env.LULU_WEBHOOK_SECRET;
  const body = await request.text();

  if (secret) {
    const sig = request.headers.get('lulu-hmac-sha256');
    if (!verifyHmac(body, sig, secret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let payload: LuluWebhookPayload;
  try {
    payload = JSON.parse(body) as LuluWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = await applyLuluStatusUpdate(payload, resolveOrderByJobId);
  if (result.ok === true) return NextResponse.json({ received: true });

  // Lulu retries on non-2xx. Log + 200 for unknown orders to prevent infinite retries.
  console.warn(`[lulu-webhook] ${result.error}`);
  return NextResponse.json({ received: true, warning: result.error });
}
