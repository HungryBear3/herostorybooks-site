import { getOrder, updateFulfillmentState, updateOrderStatus } from './orders.ts';
import { triggerFulfillment, approvePrintProof } from './fulfillment.ts';
import { sendProofReadyEmail, sendLifecycleEmail } from './order-email.ts';

export type ActionResult =
  | { ok: true; detail?: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type RetryResult = ActionResult;

// ── Retry ─────────────────────────────────────────────────────────────────────

export async function retryOrderFulfillment(orderId: string): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Cannot retry: payment not confirmed' };
  }

  await updateFulfillmentState(orderId, {
    fulfillmentStatus: 'not_started',
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
  });

  triggerFulfillment(orderId).catch(err =>
    console.error(`[admin] retry trigger failed for ${orderId}:`, err),
  );

  return { ok: true };
}

// ── Ship / mark shipped ───────────────────────────────────────────────────────

export interface ShipInput {
  trackingNumber?: string;
  trackingUrl?: string;
}

export async function markOrderShipped(
  orderId: string,
  input: ShipInput,
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  if (!isPrint) {
    return { ok: false, status: 400, error: 'Only print orders can be marked shipped' };
  }
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Payment not confirmed' };
  }

  const tracking = (input.trackingNumber ?? '').trim();
  const trackingUrl = (input.trackingUrl ?? '').trim();

  await updateFulfillmentState(orderId, {
    status: 'shipped',
    ...(tracking ? { trackingNumber: tracking } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    shippedAt: new Date().toISOString(),
  });

  const updated = await getOrder(orderId);
  if (updated) {
    try {
      await sendLifecycleEmail(updated, {
        trackingNumber: tracking || undefined,
        trackingUrl: trackingUrl || undefined,
      });
    } catch (err) {
      console.error(`[admin] shipped email failed for ${orderId}:`, err);
    }
  }

  return { ok: true };
}

// ── Resend proof email ────────────────────────────────────────────────────────

export async function resendProofEmail(
  orderId: string,
  baseUrl: string,
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (!order.storyArtifactUrl || !order.proofApprovalToken) {
    return { ok: false, status: 409, error: 'No proof ready to resend' };
  }
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, status: 409, error: `Proof is in state ${order.fulfillmentStatus}` };
  }

  const reviewUrl = `${baseUrl.replace(/\/$/, '')}/review/${order.id}?token=${order.proofApprovalToken}`;
  await sendProofReadyEmail(order, { proofUrl: order.storyArtifactUrl, reviewUrl });
  return { ok: true, detail: 'Proof email resent' };
}

// ── Manual proof approval (ops override) ──────────────────────────────────────

export async function manuallyApproveProof(orderId: string): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, status: 409, error: `Proof is in state ${order.fulfillmentStatus}` };
  }
  if (!order.proofApprovalToken) {
    return { ok: false, status: 409, error: 'No approval token on order' };
  }

  // Reuse the same code path as the customer approval — pass the stored token.
  const result = await approvePrintProof(order.id, order.proofApprovalToken);
  if (!result.ok) {
    return { ok: false, status: 409, error: result.error ?? 'Approval failed' };
  }
  return { ok: true, detail: 'Proof manually approved' };
}

// ── Lulu status sync ──────────────────────────────────────────────────────────

export interface LuluWebhookPayload {
  data?: {
    id?: number | string;
    status?: { name?: string } | string;
    line_items?: Array<{
      tracking_id?: string | null;
      tracking_urls?: string[] | null;
      external_id?: string | null;
    }>;
    external_id?: string | null;
  };
  topic?: string;
}

function extractLuluStatus(payload: LuluWebhookPayload): string | null {
  const status = payload.data?.status;
  if (!status) return null;
  if (typeof status === 'string') return status.toUpperCase();
  return (status.name ?? '').toUpperCase() || null;
}

function extractTracking(payload: LuluWebhookPayload): { trackingNumber?: string; trackingUrl?: string } {
  const items = payload.data?.line_items ?? [];
  for (const item of items) {
    const num = item.tracking_id;
    const urls = item.tracking_urls;
    if (num || (urls && urls.length > 0)) {
      return {
        ...(num ? { trackingNumber: num } : {}),
        ...(urls && urls[0] ? { trackingUrl: urls[0] } : {}),
      };
    }
  }
  return {};
}

/**
 * Apply an incoming Lulu webhook to the matching order.
 * Resolves the order by external_id (preferred) or by matching printJobId.
 */
export async function applyLuluStatusUpdate(
  payload: LuluWebhookPayload,
  resolveOrderByJobId?: (jobId: string) => Promise<string | null>,
): Promise<ActionResult> {
  const externalId = payload.data?.external_id ?? payload.data?.line_items?.[0]?.external_id;
  const jobId = payload.data?.id != null ? String(payload.data.id) : null;

  let orderId = (externalId ?? '').trim() || null;
  if (!orderId && jobId && resolveOrderByJobId) {
    orderId = await resolveOrderByJobId(jobId);
  }
  if (!orderId) {
    return { ok: false, status: 404, error: 'Could not resolve order from Lulu payload' };
  }

  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const status = extractLuluStatus(payload);
  const tracking = extractTracking(payload);

  const patch: Parameters<typeof updateFulfillmentState>[1] = {
    ...(status ? { printJobStatus: status } : {}),
    ...(tracking.trackingNumber ? { trackingNumber: tracking.trackingNumber } : {}),
    ...(tracking.trackingUrl ? { trackingUrl: tracking.trackingUrl } : {}),
  };

  // Map Lulu status → order.status
  if (status === 'IN_PRODUCTION' || status === 'PRODUCTION_READY' || status === 'PRODUCTION_DELAYED') {
    patch.status = 'print_in_production';
  } else if (status === 'SHIPPED') {
    patch.status = 'shipped';
    patch.shippedAt = new Date().toISOString();
  } else if (status === 'REJECTED' || status === 'CANCELED') {
    patch.fulfillmentStatus = 'failed_manual_review';
    patch.fulfillmentLastError = `Lulu returned ${status}`;
  }

  await updateFulfillmentState(orderId, patch);

  // Send shipped email on SHIPPED transition (idempotent: only if not already shipped)
  if (status === 'SHIPPED' && order.status !== 'shipped') {
    const updated = await getOrder(orderId);
    if (updated) {
      try {
        await sendLifecycleEmail(updated, {
          trackingNumber: tracking.trackingNumber,
          trackingUrl: tracking.trackingUrl,
        });
      } catch (err) {
        console.error(`[lulu-webhook] lifecycle email failed for ${orderId}:`, err);
      }
    }
  }

  return { ok: true, detail: status ?? 'updated' };
}
