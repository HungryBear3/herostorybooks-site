import { adoptManualMediaProof } from '@/lib/manual-media-proof-adoption';
import { manualMediaProofRuntime } from '@/lib/manual-media-proof-runtime';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  const result = await adoptManualMediaProof(request, orderId, manualMediaProofRuntime);
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
