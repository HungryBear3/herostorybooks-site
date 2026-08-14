/**
 * Customer-facing review experience for the tokenized text-placement editor,
 * driven through a real browser at a desktop viewport.
 *
 * Assertions are state-based (announced geometry, control state, persisted
 * store) rather than timing-based. Synthetic fixtures only.
 */
import { test, expect, BOUNDS, overrideOf } from './fixtures.ts';

/** Parse the editor's own live-region announcement into numbers. */
async function announcedGeometry(page: any) {
  const text = await page.getByTestId('layout-geometry-status').textContent();
  const nums = (text ?? '').match(/(\d+)%/g)?.map((s: string) => parseInt(s, 10)) ?? [];
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

async function cardBox(page: any) {
  const box = await page.getByTestId('layout-card').boundingBox();
  if (!box) throw new Error('layout card has no box');
  return box;
}

// ── access ───────────────────────────────────────────────────────────────────

test.describe('token access to the review surface', () => {
  test('a valid token opens the editor', async ({ page, seed, openEditor }) => {
    const o = seed();
    await openEditor(o, page);
    await expect(page.getByTestId('layout-card')).toBeVisible();
    await expect(page.getByTestId('layout-save')).toBeEnabled();
  });

  test('a wrong token never renders the editor or the story text', async ({ page, seed }) => {
    const o = seed({ storyText: 'CANARY_STORY_TEXT_do_not_leak.' });
    await page.goto(`/review/${o.orderId}?token=${'z'.repeat(48)}`);
    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);
    await expect(page.getByTestId('open-layout-editor')).toHaveCount(0);
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('CANARY_STORY_TEXT');
    expect(body).not.toContain(o.token);
  });

  test('a missing token never renders the editor', async ({ page, seed }) => {
    const o = seed();
    await page.goto(`/review/${o.orderId}`);
    await expect(page.getByTestId('open-layout-editor')).toHaveCount(0);
  });
});

// ── lifecycle gating in the UI ───────────────────────────────────────────────

test.describe('lifecycle lock is visible in the UI', () => {
  for (const state of ['approved', 'finalized', 'shipped', 'in_production', 'refunded', 'unpaid'] as const) {
    test(`${state} does not offer layout editing`, async ({ page, seed, gotoReview }) => {
      const o = seed({ state });
      await gotoReview(o, page);
      await expect(page.getByTestId('open-layout-editor')).toHaveCount(0);
      await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);
    });
  }

  test('a stale proof does not offer layout editing', async ({ page, seed, gotoReview }) => {
    const o = seed({ state: 'stale_proof' });
    await gotoReview(o, page);
    await expect(page.getByTestId('open-layout-editor')).toHaveCount(0);
  });
});

// ── moving and resizing ──────────────────────────────────────────────────────

test.describe('moving the text card', () => {
  test('arrow keys move the card by an exact step without resizing it', async ({ page, seed, openEditor }) => {
    // Seeded geometry is known exactly: x=10% y=12% w=60% h=30%.
    const o = seed({ withOverride: true });
    await openEditor(o, page);
    await page.getByTestId('layout-card').focus();

    // Shift = the 5% large step, so the assertion is exact, not directional.
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await announcedGeometry(page)).x).toBe(15);

    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => (await announcedGeometry(page)).y).toBe(17);

    // Moving must never resize.
    const after = await announcedGeometry(page);
    expect(after.width).toBe(60);
    expect(after.height).toBe(30);
  });

  test('a pointer drag moves the card', async ({ page, seed, openEditor }) => {
    const o = seed();
    await openEditor(o, page);
    const before = await cardBox(page);

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 40, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => (await cardBox(page)).x).toBeGreaterThan(before.x);
  });

  test('the card can never be dragged outside the page-safe area', async ({ page, seed, openEditor }) => {
    const o = seed();
    await openEditor(o, page);
    const frame = await page.getByTestId('preview-frame').boundingBox();
    const box = await cardBox(page);

    // Yank hard past the top-left corner of the preview.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(frame!.x - 400, frame!.y - 400, { steps: 15 });
    await page.mouse.up();

    const g = await announcedGeometry(page);
    expect(g.x).toBeGreaterThanOrEqual(4); // 5% safe margin, allowing rounding
    expect(g.y).toBeGreaterThanOrEqual(4);
  });
});

test.describe('resizing the text card', () => {
  test('Alt+arrow resizes by an exact step without moving the origin', async ({ page, seed, openEditor }) => {
    const o = seed({ withOverride: true }); // x=10% y=12% w=60% h=30%
    await openEditor(o, page);
    await page.getByTestId('layout-card').focus();

    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(async () => (await announcedGeometry(page)).width).toBe(65);

    const after = await announcedGeometry(page);
    expect(after.x).toBe(10);
    expect(after.y).toBe(12);
  });

  test('dragging the handle grows the card', async ({ page, seed, openEditor }) => {
    const o = seed({ withOverride: true });
    await openEditor(o, page);
    const before = await cardBox(page);
    const handle = await page.getByTestId('layout-resize-handle').boundingBox();

    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 120, handle!.y + 60, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => (await cardBox(page)).width).toBeGreaterThan(before.width);
  });

  test('resizing is bounded by the server maximums', async ({ page, seed, openEditor }) => {
    const o = seed();
    await openEditor(o, page);
    const handle = await page.getByTestId('layout-resize-handle').boundingBox();

    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 5000, handle!.y + 5000, { steps: 15 });
    await page.mouse.up();

    const g = await announcedGeometry(page);
    expect(g.width).toBeLessThanOrEqual(BOUNDS.width.max * 100 + 1);
    expect(g.height).toBeLessThanOrEqual(BOUNDS.height.max * 100 + 1);
  });
});

// ── style controls ───────────────────────────────────────────────────────────

test.describe('style controls', () => {
  test('opacity and text size persist exactly as chosen', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);

    await page.getByTestId('layout-opacity').fill('0.75');
    await page.getByTestId('layout-fontscale').fill('1.1');
    await expect(page.getByTestId('layout-save')).toBeEnabled();
    await page.getByTestId('layout-save').click();

    // A real mutation closes the editor.
    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);

    const ov = overrideOf(readOrder(o.orderId));
    expect(ov).not.toBeNull();
    expect(ov.opacity).toBeCloseTo(0.75, 2);
    expect(ov.fontScale).toBeCloseTo(1.1, 2);
  });

  test('an approved text colour is applied and persisted', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);

    const charcoal = page.getByRole('button', { name: /Charcoal/i });
    await charcoal.click();
    await expect(charcoal).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('layout-save').click();
    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);
    expect(overrideOf(readOrder(o.orderId)).textColor).toBe('charcoal');
  });

  test('an illegible colour/opacity combination blocks saving client-side too', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);

    await page.getByRole('button', { name: /Cream/i }).click();
    await page.getByTestId('layout-opacity').fill(String(BOUNDS.opacity.min));

    await expect(page.getByTestId('layout-save-blocked')).toBeVisible();
    await expect(page.getByTestId('layout-save')).toBeDisabled();
    // Nothing may have been written.
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });
});

// ── overflow ─────────────────────────────────────────────────────────────────

test.describe('overflow is surfaced from the authoritative fit route', () => {
  test('a tiny card with long text warns and blocks save', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed({ storyText: 'Overflowing sentence. '.repeat(120) });
    await openEditor(o, page);

    const handle = await page.getByTestId('layout-resize-handle').boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x - 5000, handle!.y - 5000, { steps: 15 });
    await page.mouse.up();

    await expect(page.getByTestId('layout-overflow-note')).toContainText(/doesn’t fit|couldn’t check/);
    await expect(page.getByTestId('layout-save')).toBeDisabled();
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });
});

// ── persistence across reload ────────────────────────────────────────────────

test.describe('persistence', () => {
  test('a saved placement is what the server hands back on reload', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);
    // 0.8 is comfortably above the contrast floor for the default colour;
    // lower values are legitimately blocked by the readability gate.
    await page.getByTestId('layout-opacity').fill('0.8');
    // Changing geometry re-runs the authoritative fit check, which re-disables
    // Save until it answers. Wait on that state, never on a timeout.
    await expect(page.getByTestId('layout-save')).toBeEnabled();
    await page.getByTestId('layout-save').click();
    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);

    const saved = overrideOf(readOrder(o.orderId));
    expect(saved.opacity).toBeCloseTo(0.8, 2);

    // Reload the tokenized surface: the write survived and the page still loads.
    await page.reload();
    await expect(page.getByTestId('review-scope-banner')).toBeVisible();
    expect(overrideOf(readOrder(o.orderId)).opacity).toBeCloseTo(0.8, 2);
  });

  test('an already-applied placement is rendered back into the editor', async ({ page, seed, openEditor }) => {
    // Seeded with x=0.1 y=0.12 w=0.6 h=0.3 and a live proof.
    const o = seed({ withOverride: true });
    await openEditor(o, page);
    const g = await announcedGeometry(page);
    expect(g.x).toBe(10);
    expect(g.y).toBe(12);
    expect(g.width).toBe(60);
    expect(g.height).toBe(30);
  });
});

// ── reset ────────────────────────────────────────────────────────────────────

test.describe('reset', () => {
  test('reset is offered only when an override exists, and clears it', async ({ page, seed, openEditor, readOrder }) => {
    const clean = seed();
    await openEditor(clean, page);
    await expect(page.getByTestId('layout-reset')).toBeDisabled();

    const dirty = seed({ withOverride: true });
    await openEditor(dirty, page);
    await expect(page.getByTestId('layout-reset')).toBeEnabled();
    await page.getByTestId('layout-reset').click();

    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);
    expect(overrideOf(readOrder(dirty.orderId))).toBeNull();
  });
});

// ── request help ─────────────────────────────────────────────────────────────

test.describe('request help', () => {
  test('keeps the editor open and reports status without leaking', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);
    await page.getByTestId('layout-request-help').click();

    await expect(page.getByTestId('layout-status')).not.toBeEmpty();
    // Help must NOT close the editor.
    await expect(page.getByTestId('customer-layout-editor')).toBeVisible();
    await expect(page.getByTestId('layout-error')).toBeEmpty();

    const after = readOrder(o.orderId);
    expect((after.auditEvents ?? []).filter((e: any) => e.type === 'layout_help_requested')).toHaveLength(1);
    // No layout was written and the proof is untouched.
    expect(overrideOf(after)).toBeNull();
    expect(after.storyArtifactUrl).toBe('https://example.invalid/proof.pdf');
  });
});

// ── error surface ────────────────────────────────────────────────────────────

test.describe('error states', () => {
  test('a stale tab reports a reload-and-retry error, not internals', async ({ page, seed, openEditor, api, request, readOrder }) => {
    const o = seed({ storyText: 'CANARY_STORY_TEXT_do_not_leak.' });
    await openEditor(o, page);

    // Consume the revision behind the open tab, exactly like a second device would.
    const other = await api(request, 'proof-layout', o.orderId, {
      pageIndex: 0,
      geometry: { x: 0.2, y: 0.2, width: 0.5, height: 0.2, opacity: 0.9, fontScale: 1 },
      authoredAgainstProofVersion: o.proofVersion,
      authoredAgainstFingerprint: o.proofSourceFingerprint,
    }, o.token);
    expect(other.status).toBe(200);
    const afterOther = overrideOf(readOrder(o.orderId));

    // Save is already enabled (fit resolved when the editor opened), so this
    // commits the ORIGINAL binding — which the server has since consumed.
    await page.getByTestId('layout-save').click();

    const err = page.getByTestId('layout-error');
    await expect(err).not.toBeEmpty();
    const text = (await err.textContent()) ?? '';
    expect(text).not.toContain(o.token);
    expect(text).not.toContain('CANARY_STORY_TEXT');
    expect(text).not.toMatch(/\/Users\/|src\/lib|node_modules|at\s+\w+\s+\(/);

    // The losing write changed nothing.
    expect(overrideOf(readOrder(o.orderId))).toEqual(afterOther);
  });
});
