import { get } from '@vercel/blob';
import { isAdminAuthedFromRequest } from './admin-auth.ts';
import { commitOrderConditional, readOrderVersioned } from './orders.ts';
import type { ManualAdoptionDeps } from './manual-media-proof-adoption.ts';
export const manualMediaProofRuntime: ManualAdoptionDeps = {
  authenticate: isAdminAuthedFromRequest,
  readOrder: id => readOrderVersioned(id, { preferRecentCommit: false }),
  commit: commitOrderConditional,
  async readArtifact(pathname, maxBytes) {
    const token = process.env.HSB_PRIVATE_READ_WRITE_TOKEN?.trim();
    if (!token || token === process.env.BLOB_READ_WRITE_TOKEN?.trim()) throw new Error('private_credential_unavailable');
    const result = await get(pathname, { access: 'private', token, useCache: false });
    if (!result || result.statusCode !== 200) throw new Error('private_artifact_missing');
    const reader = result.stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) throw new Error('private_artifact_oversize'); chunks.push(value);
    } } finally { await reader.cancel(); }
    return { pathname: result.blob.pathname, contentType: result.blob.contentType ?? '', body: Buffer.concat(chunks) };
  },
};
