import { characterReviewRequest } from '@/lib/character-review';
import { manualMediaProofRuntime } from '@/lib/manual-media-proof-runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
 const { orderId } = await context.params;
 return characterReviewRequest(request, orderId, manualMediaProofRuntime, true);
}
export const GET = POST;
