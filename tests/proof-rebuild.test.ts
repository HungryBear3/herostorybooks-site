import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { rebuildProofFromPageArtifacts } from '../src/lib/fulfillment.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-rebuild-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1} story.`,
    basePrompt: `Original prompt for ${i}`,
    currentImageUrl: `https://example.com/current-${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

test('rebuildProofFromPageArtifacts: passes accepted/current URLs to PDF builder', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
      { id: 'ord_rebuild', now: '2026-04-26T10:00:00Z' },
    );
    const order: OrderRecord = {
      ...base,
      paymentStatus: 'paid',
      generationRouteDecision: {
        route: 'api_disabled_template',
        source: 'template',
        model: 'template:Adventure',
        decidedAt: '2026-06-01T12:00:00.000Z',
        releasable: true,
      },
      auditEvents: [
        {
          at: '2026-06-01T12:00:00.000Z',
          type: 'route_decision_recorded',
          meta: { route: 'api_disabled_template', source: 'template', model: 'template:Adventure', releasable: true },
        },
      ],
      pageArtifacts: [
        pageFixture(0, {
          accepted: true,
          acceptedImageUrl: 'https://example.com/accepted-0.png',
          currentImageUrl: 'https://example.com/regen-0.png',
        }),
        pageFixture(1),
        pageFixture(2, {
          accepted: true,
          acceptedImageUrl: 'https://example.com/accepted-2.png',
        }),
      ],
    };
    await persistOrder(order);

    let capturedUrls: (string | null)[] = [];
    const result = await rebuildProofFromPageArtifacts('ord_rebuild', {
      buildPdf: async (_story, _order, urls) => {
        capturedUrls = urls;
        return Buffer.from('%PDF rebuilt');
      },
      uploadArtifact: async (orderId, _buffer, filename) => `https://cdn.example.com/${orderId}/${filename}`,
    });
    assert.equal(result.ok, true);
    // PDF builder receives [coverUrl, ...page urls]; first slot is the cover (page 0)
    assert.deepEqual(capturedUrls, [
      'https://example.com/accepted-0.png', // cover slot uses page 0
      'https://example.com/accepted-0.png',
      'https://example.com/current-1.png',
      'https://example.com/accepted-2.png',
    ]);

    const after = await getOrder('ord_rebuild');
    assert.match(after!.storyArtifactUrl ?? '', /-proof\.pdf$/);
  } finally {
    cleanup(dir);
  }
});

test('rebuildProofFromPageArtifacts: 404 when no page artifacts', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'l@e.com' },
      { id: 'ord_no_artifacts', now: '2026-04-26T10:00:00Z' },
    );
    await persistOrder({ ...base, paymentStatus: 'paid' });
    const r = await rebuildProofFromPageArtifacts('ord_no_artifacts', {
      buildPdf: async () => Buffer.from('x'),
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /no page artifacts/i);
  } finally {
    cleanup(dir);
  }
});
