/**
 * Renderer-side tests: getPictureBookStoryLayout / fitPictureBookText must honor
 * saved position + sizePreset overrides while keeping text inside safe bounds,
 * and must reproduce legacy behavior exactly when no override is present.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPictureBookStoryLayout,
  fitPictureBookText,
} from '../src/lib/pdf-builder.ts';
import type { PageTextLayout } from '../src/lib/fulfillment-types.ts';

const PROOF_W = 595.28;
const PROOF_H = 841.89;
const PRINT_DIM = 8.5 * 72;

test('legacy layout (no position) renders the default bottom band unchanged', () => {
  const withNothing = getPictureBookStoryLayout('proof');
  const legacy: PageTextLayout = { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' };
  const withLegacy = getPictureBookStoryLayout('proof', legacy);
  assert.deepEqual(withLegacy, withNothing, 'legacy layout must not shift the band');
  // Default band sits below the art region.
  assert.ok(withNothing.textPanelY >= withNothing.imageHeight - 1);
});

test('position override moves the panel and stays inside the page (proof)', () => {
  const layout: PageTextLayout = {
    zone: 'natural',
    colorMode: 'auto',
    panelStyle: 'translucent_cream',
    position: { xPct: 20, yPct: 30, widthPct: 60 },
  };
  const out = getPictureBookStoryLayout('proof', layout);
  assert.ok(out.textPanelX >= 0);
  assert.ok(out.textPanelY >= 0);
  assert.ok(out.textPanelX + out.textPanelWidth <= PROOF_W, 'right edge inside page');
  assert.ok(out.textPanelY + out.textPanelHeight <= PROOF_H, 'bottom edge inside page');
  // It actually moved off the default bottom band.
  const def = getPictureBookStoryLayout('proof');
  assert.ok(out.textPanelY < def.textPanelY, 'panel moved up from default band');
});

test('extreme/garbage position is clamped inside printable bounds (proof + print)', () => {
  const layout: PageTextLayout = {
    zone: 'natural',
    colorMode: 'auto',
    panelStyle: 'translucent_cream',
    position: { xPct: 999, yPct: 999, widthPct: 999 },
  };
  const proof = getPictureBookStoryLayout('proof', layout);
  assert.ok(proof.textPanelX + proof.textPanelWidth <= PROOF_W + 0.01);
  assert.ok(proof.textPanelY + proof.textPanelHeight <= PROOF_H + 0.01);
  assert.ok(proof.textPanelX >= 0 && proof.textPanelY >= 0);

  const print = getPictureBookStoryLayout('print', layout);
  assert.ok(print.textPanelX + print.textPanelWidth <= PRINT_DIM + 0.01);
  assert.ok(print.textPanelY + print.textPanelHeight <= PRINT_DIM + 0.01);
  assert.ok(print.textPanelX >= 0 && print.textPanelY >= 0);
});

test('sizePreset medium reproduces the default fit exactly', () => {
  const layout = getPictureBookStoryLayout('proof');
  const story = 'Luna walked along the quiet riverbank as the evening sky turned gold and soft.';
  const baseline = fitPictureBookText(layout, '', story, { renderTitle: false });
  const medium = fitPictureBookText(layout, '', story, { renderTitle: false, sizePreset: 'medium' });
  assert.deepEqual(medium, baseline);
});

test('sizePreset large starts no smaller than small for the same text', () => {
  const layout = getPictureBookStoryLayout('proof');
  const story = 'A short line.';
  const small = fitPictureBookText(layout, '', story, { renderTitle: false, sizePreset: 'small' });
  const large = fitPictureBookText(layout, '', story, { renderTitle: false, sizePreset: 'large' });
  assert.ok(large.storyFontSize >= small.storyFontSize, 'large preset >= small for short copy');
});

test('fitted story always stays within the safe zone height regardless of preset', () => {
  const layout = getPictureBookStoryLayout('proof');
  const story = 'Word '.repeat(200);
  for (const preset of ['small', 'medium', 'large'] as const) {
    const fit = fitPictureBookText(layout, '', story, { renderTitle: false, sizePreset: preset });
    const safeBottom = layout.textPanelY + layout.textPanelHeight - layout.panelVerticalInset;
    assert.ok(fit.storyDrawY >= layout.textPanelY, `${preset}: story starts inside panel`);
    assert.ok(fit.storyDrawY + fit.storyDrawHeight <= safeBottom + 0.01, `${preset}: story within safe zone`);
  }
});
