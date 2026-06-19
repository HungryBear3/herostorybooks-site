import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';

import { getBlobAccessMode, requiresDurablePersistence, withBlobNamespace } from '@/lib/orders';

const MAX_SPLIT_UPLOAD_BYTES = 3.6 * 1024 * 1024;
const VALID_KINDS = new Set(['photo', 'supporting', 'voice']);

function cleanSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function uploadPath(kind: string, draftId: string, fileName: string, index: string | null): string {
  const safeDraft = cleanSegment(draftId, crypto.randomUUID());
  const safeName = cleanSegment(fileName || kind, kind);
  if (kind === 'photo') return `orders/_checkout-drafts/${safeDraft}/photo-${safeName}`;
  if (kind === 'voice') return `orders/_checkout-drafts/${safeDraft}/voice-${safeName}`;
  const safeIndex = cleanSegment(index || '1', '1');
  return `orders/_checkout-drafts/${safeDraft}/supporting-${safeIndex}-photo-${safeName}`;
}

export async function POST(request: Request) {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      if (requiresDurablePersistence()) {
        return NextResponse.json(
          { ok: false, error: 'Private upload storage is unavailable. Please retry later.' },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: false, error: 'Blob storage is not configured.' }, { status: 503 });
    }

    const form = await request.formData();
    const file = form.get('file');
    const kind = String(form.get('kind') || '').trim();
    const draftId = String(form.get('draftId') || '').trim();
    const index = form.get('index') === null ? null : String(form.get('index'));

    if (!VALID_KINDS.has(kind)) {
      return NextResponse.json({ ok: false, error: 'Invalid upload kind.' }, { status: 400 });
    }
    if (!draftId || draftId.length > 120) {
      return NextResponse.json({ ok: false, error: 'Invalid checkout draft.' }, { status: 400 });
    }
    if (!(file instanceof File) || file.size <= 0) {
      return NextResponse.json({ ok: false, error: 'Missing upload file.' }, { status: 400 });
    }
    if (file.size > MAX_SPLIT_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'That file is too large. Please use a smaller photo/audio note and retry.' },
        { status: 413 },
      );
    }

    const pathname = withBlobNamespace(uploadPath(kind, draftId, file.name, index));
    const buffer = Buffer.from(await file.arrayBuffer());
    const blob = await put(pathname, buffer, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: file.type || 'application/octet-stream',
      token,
    });

    return NextResponse.json({
      ok: true,
      fileName: file.name || null,
      pathname: blob.pathname,
      url: blob.url,
      size: file.size,
      contentType: file.type || null,
    });
  } catch (error) {
    console.error('[order/upload] split upload failed:', error);
    return NextResponse.json(
      { ok: false, error: 'Upload failed before payment. You have not been charged.' },
      { status: 500 },
    );
  }
}
