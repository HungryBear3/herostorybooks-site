/**
 * `POST /api/checkout/intake/upload` — the Vercel Blob client-upload endpoint.
 *
 * Two callers with two different authentications land here: the browser asking
 * for an upload token, and Vercel Blob reporting the upload finished. The
 * split lives in `checkout-intake-upload-route.ts`; this file only wires the
 * real dependencies to it.
 */
import { handleUpload } from '@vercel/blob/client';

import {
  handleIntakeUploadRequest,
  type IntakeUploadRouteDeps,
} from '../../../../../lib/checkout-intake-upload-route.ts';
import {
  createVercelIntakeStore,
  getRequiredIntakeBlobToken,
} from '../../../../../lib/checkout-intake.ts';
import { isDirectUploadServerEnabled } from '../../../../../lib/checkout-direct-flags.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!isDirectUploadServerEnabled(process.env)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  let deps: IntakeUploadRouteDeps;
  try {
    const blobToken = getRequiredIntakeBlobToken();
    deps = {
      handleUpload,
      store: createVercelIntakeStore(blobToken),
      env: process.env,
      blobToken,
    };
  } catch {
    return Response.json({ error: 'intake_store_unavailable' }, { status: 503 });
  }
  return handleIntakeUploadRequest(request, deps);
}
