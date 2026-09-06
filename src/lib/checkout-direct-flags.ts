/**
 * Feature flags for the direct private-upload checkout path.
 *
 * Both default OFF. With the server flag off the intake routes answer 404 —
 * not 503, not an empty success — so nothing about the endpoint's existence
 * leaks and no half-enabled state is reachable. With the client flag off the
 * checkout form keeps posting media on the order request exactly as it does
 * today.
 *
 * They are separate on purpose: the server side has to be live and verified in
 * an environment BEFORE any browser in it starts uploading directly, and
 * turning the client flag off has to be enough to stop new direct uploads
 * without tearing down the server that is still reconciling in-flight ones.
 */
export function isDirectUploadServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HSB_CHECKOUT_DIRECT_UPLOAD === 'true';
}

export function isDirectUploadClientEnabled(): boolean {
  return process.env.NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD === 'true';
}
