import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdf } from '../src/lib/pdf-builder.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';

function countPdfPages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
}

const SHORT_STORY: StoryContent = {
  title: "Luna's Great Adventure",
  dedication: 'For Luna',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'The Beginning', story: 'Luna begins her quest.', imagePrompt: 'Luna in a forest' },
    { pageNum: 2, sceneTitle: 'The Challenge', story: 'Luna faces a challenge.', imagePrompt: 'Luna climbing a hill' },
    { pageNum: 3, sceneTitle: 'The Victory', story: 'Luna returns home smiling.', imagePrompt: 'Luna celebrating' },
  ],
};

test('buildPdf pads classic print books to Lulu minimum page count', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' });
  const pdf = await buildPdf(SHORT_STORY, order, [null, null, null, null]);

  assert.ok(countPdfPages(pdf) >= 32, `expected classic print PDF to have at least 32 pages, got ${countPdfPages(pdf)}`);
});

test('buildPdf pads premium print books to Lulu minimum page count', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'premium', email: 'luna@example.com' });
  const pdf = await buildPdf(SHORT_STORY, order, [null, null, null, null]);

  assert.ok(countPdfPages(pdf) >= 24, `expected premium print PDF to have at least 24 pages, got ${countPdfPages(pdf)}`);
});
