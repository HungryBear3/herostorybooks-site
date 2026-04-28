// LEGACY ENDPOINT — retired as a one-click approval path.
//
// This endpoint historically performed a single-GET approval that bypassed
// per-page accept, the proof acknowledgment, and the server-gated whole-book
// approval. Customer-facing emails now point at /review/<orderId>?token=...
// (the modern review surface), but stale emails in customer inboxes may still
// hit this URL.
//
// Behavior now:
//   - With token: 302 redirect to /review/<orderId>?token=<token>
//   - Without token: 302 redirect to /review/<orderId> (the review page itself
//     surfaces a clear "missing/invalid token" message). We avoid a hard 400
//     so customers don't dead-end on a vague error.
//
// We deliberately do NOT call approvePrintProof here anymore. The function
// itself still exists and is used internally by approveWholeBook and the
// admin manual-approve action — only the HTTP one-click bypass is gone.

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const { orderId } = await context.params;

  const base = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
  const target = token
    ? `${base}/review/${orderId}?token=${encodeURIComponent(token)}`
    : `${base}/review/${orderId}`;

  return Response.redirect(target, 302);
}
