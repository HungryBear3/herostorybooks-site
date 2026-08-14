/**
 * Server-side safety boundaries for the tokenized customer text-placement
 * editor, exercised by DIRECT HTTP calls that bypass the UI entirely.
 *
 * The point of this file is that no client-side control may mask a server
 * authorization defect: every request here is one a hostile client could send.
 * Synthetic fixtures only.
 */
import { test, expect, ROOMY, BOUNDS, SAFE_MARGIN, bindingOf, overrideOf } from './fixtures.ts';

const apply = (o: any, extra: Record<string, unknown> = {}) => ({
  pageIndex: 0, geometry: ROOMY, ...bindingOf(o), ...extra,
});

// ── token authorization ──────────────────────────────────────────────────────

test.describe('token authorization', () => {
  test('a valid token applies the override', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'proof-layout', o.orderId, apply(o), o.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(overrideOf(readOrder(o.orderId))).not.toBeNull();
  });

  for (const [label, token] of [
    ['missing', null],
    ['malformed', '!!!not-a-token!!!'],
    ['invalid', 'z'.repeat(48)],
    ['empty', ''],
  ] as const) {
    test(`a ${label} token is refused 403 with no mutation`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId, apply(o), token);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('invalid_or_missing_token');
      expect(overrideOf(readOrder(o.orderId))).toBeNull();
    });
  }

  test('a revoked capability (no token on the order) is refused', async ({ seed, api, request, readOrder }) => {
    const o = seed({ overrides: { proofApprovalToken: null } as any });
    const res = await api(request, 'proof-layout', o.orderId, apply(o), 'any-token-at-all');
    expect(res.status).toBe(403);
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });

  test('an unknown order is 404 and leaks nothing', async ({ seed, api, request }) => {
    const o = seed();
    const res = await api(request, 'proof-layout', 'ord_does_not_exist', apply(o), o.token);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('order_not_found');
  });
});

// ── cross-order isolation ────────────────────────────────────────────────────

test.describe('cross-order isolation', () => {
  test('customer B token cannot read, alter, or reset customer A order', async ({ seed, api, request, readOrder }) => {
    const a = seed();
    const b = seed();
    expect(a.token).not.toBe(b.token);

    for (const route of ['proof-layout', 'proof-fit', 'request-help'] as const) {
      const res = await api(request, route, a.orderId, apply(a), b.token);
      expect(res.status, `${route} must refuse a foreign token`).toBe(403);
      expect(res.body.error).toBe('invalid_or_missing_token');
    }

    // A reset attempt (geometry omitted) is equally refused.
    const reset = await api(request, 'proof-layout', a.orderId, { pageIndex: 0, ...bindingOf(a) }, b.token);
    expect(reset.status).toBe(403);

    // Neither order was touched.
    const afterA = readOrder(a.orderId);
    const afterB = readOrder(b.orderId);
    expect(overrideOf(afterA)).toBeNull();
    expect(overrideOf(afterB)).toBeNull();
    expect(afterA.auditEvents ?? []).toHaveLength(0);
    expect(afterB.auditEvents ?? []).toHaveLength(0);
  });

  test("A's own valid token still cannot reach B's order", async ({ seed, api, request, readOrder }) => {
    const a = seed();
    const b = seed();
    const res = await api(request, 'proof-layout', b.orderId, apply(b), a.token);
    expect(res.status).toBe(403);
    expect(overrideOf(readOrder(b.orderId))).toBeNull();
  });
});

// ── proof-version / fingerprint binding ──────────────────────────────────────

test.describe('proof binding', () => {
  const cases = [
    ['a stale proof revision', { authoredAgainstProofVersion: 'pv_stale' }, 'stale_revision'],
    ['a stale fingerprint', { authoredAgainstFingerprint: 'pf_stale' }, 'stale_fingerprint'],
  ] as const;

  for (const [label, patch, expected] of cases) {
    test(`${label} is refused 409 ${expected} without mutation`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId, apply(o, patch), o.token);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(expected);
      expect(overrideOf(readOrder(o.orderId))).toBeNull();
    });
  }

  for (const [label, body] of [
    ['both binding fields missing', {}],
    ['version without fingerprint', { authoredAgainstProofVersion: 'pv_1' }],
    ['fingerprint without version', { authoredAgainstFingerprint: 'pf_x' }],
    ['empty-string version', { authoredAgainstProofVersion: '', authoredAgainstFingerprint: 'pf_x' }],
  ] as const) {
    test(`${label} fails closed with binding_required`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId,
        { pageIndex: 0, geometry: ROOMY, ...body }, o.token);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('binding_required');
      expect(overrideOf(readOrder(o.orderId))).toBeNull();
    });
  }

  test('a proof whose fingerprint no longer matches its pages is refused proof_stale', async ({ seed, api, request, readOrder }) => {
    const o = seed({ state: 'stale_proof' });
    const res = await api(request, 'proof-layout', o.orderId, apply(o), o.token);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('proof_stale');
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });
});

// ── lifecycle locks ──────────────────────────────────────────────────────────

test.describe('lifecycle locks', () => {
  const CLOSED = [
    ['approved', 409, 'order_approved'],
    ['finalized', 409, 'order_finalized'],
    ['shipped', 409, 'order_shipped'],
    ['in_production', 409, 'order_in_production'],
    ['print_submitted', 409, 'print_submitted'],
    ['refunded', 403, 'order_refunded'],
    ['unpaid', 403, 'order_not_eligible'],
  ] as const;

  for (const [state, status, error] of CLOSED) {
    test(`${state} refuses apply, reset AND request-help without mutation`, async ({ seed, api, request, readOrder }) => {
      const o = seed({ state });

      const applied = await api(request, 'proof-layout', o.orderId, apply(o), o.token);
      expect(applied.status).toBe(status);
      expect(applied.body.error).toBe(error);

      const reset = await api(request, 'proof-layout', o.orderId,
        { pageIndex: 0, ...bindingOf(o) }, o.token);
      expect(reset.status).toBe(status);

      const help = await api(request, 'request-help', o.orderId, { pageIndex: 0 }, o.token);
      expect(help.status, 'request-help must honour the same lifecycle lock').toBe(status);

      const after = readOrder(o.orderId);
      expect(overrideOf(after)).toBeNull();
      expect(after.auditEvents ?? []).toHaveLength(0);
    });
  }
});

// ── geometry: server-side bounds are authoritative ───────────────────────────

test.describe('server-side geometry enforcement', () => {
  for (const [label, body] of [
    ['a missing required field', { x: 0.1, y: 0.12, width: 0.6, height: 0.3, fontScale: 1 }],
    ['a non-finite number', { ...ROOMY, width: Number.NaN }],
    ['a numeric string', { ...ROOMY, width: '0.5' }],
    ['a null geometry field', { ...ROOMY, opacity: null }],
    ['an array instead of an object', [0.1, 0.2]],
  ] as const) {
    test(`${label} is rejected 422 invalid_geometry before persistence`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId, apply(o, { geometry: body }), o.token);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('invalid_geometry');
      expect(overrideOf(readOrder(o.orderId))).toBeNull();
    });
  }

  /**
   * NOTE ON POLICY: production CLAMPS out-of-range numeric geometry to the
   * server bounds rather than rejecting it. That is fail-safe — the invariant
   * the suite protects is that NOTHING outside the bounds can ever be
   * persisted, no matter what a hostile client sends. These tests assert the
   * invariant, not a rejection that production does not perform.
   */
  const OUT_OF_RANGE = [
    ['width below min', { ...ROOMY, width: 0.01 }],
    ['width above max', { ...ROOMY, width: 5 }],
    ['height below min', { ...ROOMY, height: 0.001 }],
    ['height above max', { ...ROOMY, height: 5 }],
    ['fontScale below min', { ...ROOMY, fontScale: 0.1 }],
    ['fontScale above max', { ...ROOMY, fontScale: 12 }],
    ['opacity above max', { ...ROOMY, opacity: 0.999 }],
    ['x far negative', { ...ROOMY, x: -10 }],
    ['y far negative', { ...ROOMY, y: -10 }],
    ['card overflowing the right edge', { ...ROOMY, x: 0.8, width: 0.5 }],
    ['card pushed into the folio strip', { ...ROOMY, y: 0.95, height: 0.4 }],
  ] as const;

  for (const [label, geometry] of OUT_OF_RANGE) {
    test(`${label} can never persist out-of-bounds values`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId, apply(o, { geometry }), o.token);

      if (res.status !== 200) {
        // Fail-closed is equally acceptable; it must simply not persist.
        expect(overrideOf(readOrder(o.orderId))).toBeNull();
        return;
      }

      const ov = overrideOf(readOrder(o.orderId));
      expect(ov).not.toBeNull();
      expect(ov.width).toBeGreaterThanOrEqual(BOUNDS.width.min);
      expect(ov.width).toBeLessThanOrEqual(BOUNDS.width.max);
      expect(ov.height).toBeGreaterThanOrEqual(BOUNDS.height.min);
      expect(ov.height).toBeLessThanOrEqual(BOUNDS.height.max);
      expect(ov.opacity).toBeGreaterThanOrEqual(BOUNDS.opacity.min);
      expect(ov.opacity).toBeLessThanOrEqual(BOUNDS.opacity.max);
      expect(ov.fontScale).toBeGreaterThanOrEqual(BOUNDS.fontScale.min);
      expect(ov.fontScale).toBeLessThanOrEqual(BOUNDS.fontScale.max);
      // Never outside the page-safe area.
      expect(ov.x).toBeGreaterThanOrEqual(SAFE_MARGIN - 1e-6);
      expect(ov.y).toBeGreaterThanOrEqual(SAFE_MARGIN - 1e-6);
      expect(ov.x + ov.width).toBeLessThanOrEqual(1 - SAFE_MARGIN + 1e-6);
      // The persisted card must clear the folio reserve at the page bottom.
      expect(ov.y + ov.height).toBeLessThanOrEqual(1 - SAFE_MARGIN + 1e-6);
      // And it must echo exactly what was stored.
      expect(res.body.proofCardOverride).toMatchObject({ width: ov.width, height: ov.height });
    });
  }

  test('text that cannot fit the card is refused before persistence', async ({ seed, api, request, readOrder }) => {
    const o = seed({ storyText: 'Overflowing sentence. '.repeat(120) });
    const tiny = { ...ROOMY, width: BOUNDS.width.min, height: BOUNDS.height.min };
    const res = await api(request, 'proof-layout', o.orderId, apply(o, { geometry: tiny }), o.token);
    expect(res.status).toBe(422);
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });

  test('an unapproved text colour is refused', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'proof-layout', o.orderId, apply(o, { textColor: 'hot_pink' }), o.token);
    expect(res.status).toBe(422);
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });

  test('an illegible colour/opacity combination is refused', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'proof-layout', o.orderId,
      apply(o, { geometry: { ...ROOMY, opacity: 0.01 } }), o.token);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_contrast');
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });
});

// ── page index ───────────────────────────────────────────────────────────────

test.describe('page addressing', () => {
  for (const [label, pageIndex, status, error] of [
    ['a page beyond the book', 99, 404, 'page_not_found'],
    ['a negative index', -1, 400, 'invalid_page_index'],
    ['a fractional index', 1.5, 400, 'invalid_page_index'],
    ['a string index', '0', 400, 'invalid_page_index'],
  ] as const) {
    test(`${label} is refused without mutation`, async ({ seed, api, request, readOrder }) => {
      const o = seed();
      const res = await api(request, 'proof-layout', o.orderId, apply(o, { pageIndex }), o.token);
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(error);
      expect(overrideOf(readOrder(o.orderId))).toBeNull();
    });
  }

  test('a malformed JSON body is refused 400', async ({ seed, request, readOrder }) => {
    const o = seed();
    const res = await request.post(
      `/api/order/${o.orderId}/proof-layout?token=${o.token}`,
      { data: 'not json at all', headers: { 'content-type': 'application/json' }, failOnStatusCode: false },
    );
    expect(res.status()).toBe(400);
    expect(overrideOf(readOrder(o.orderId))).toBeNull();
  });
});

// ── reset ────────────────────────────────────────────────────────────────────

test.describe('reset to approved placement', () => {
  test('reset removes an applied override and invalidates the proof', async ({ seed, api, request, readOrder }) => {
    const o = seed({ withOverride: true });
    expect(overrideOf(readOrder(o.orderId))).not.toBeNull();

    const reset = await api(request, 'proof-layout', o.orderId,
      { pageIndex: 0, ...bindingOf(o) }, o.token);
    expect(reset.status).toBe(200);

    const after = readOrder(o.orderId);
    expect(overrideOf(after)).toBeNull();
    // Clearing the card changes the printed proof, so the live proof must go.
    expect(after.storyArtifactUrl ?? null).toBeNull();
  });

  test('reset is itself binding-checked — a stale reset fails closed', async ({ seed, api, request, readOrder }) => {
    const o = seed({ withOverride: true });
    const before = overrideOf(readOrder(o.orderId));

    const reset = await api(request, 'proof-layout', o.orderId, {
      pageIndex: 0,
      authoredAgainstProofVersion: 'pv_OLD',
      authoredAgainstFingerprint: o.proofSourceFingerprint,
    }, o.token);
    expect(reset.status).toBe(409);
    expect(overrideOf(readOrder(o.orderId))).toEqual(before);
  });

  test('reset with nothing to reset is an idempotent no-op', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'proof-layout', o.orderId,
      { pageIndex: 0, ...bindingOf(o) }, o.token);
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
    // A no-op must NOT invalidate a perfectly good proof.
    expect(readOrder(o.orderId).storyArtifactUrl).toBe('https://example.invalid/proof.pdf');
  });
});

// ── concurrency / stale writes ───────────────────────────────────────────────

test.describe('concurrent and stale writes', () => {
  test('two concurrent applies on the same binding: exactly one wins', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const [r1, r2] = await Promise.all([
      api(request, 'proof-layout', o.orderId, apply(o, { geometry: { ...ROOMY, x: 0.1 } }), o.token),
      api(request, 'proof-layout', o.orderId, apply(o, { geometry: { ...ROOMY, x: 0.2 } }), o.token),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);

    const ov = overrideOf(readOrder(o.orderId));
    expect(ov).not.toBeNull();
    // Exactly one geometry landed — never a blend of the two.
    expect([0.1, 0.2]).toContain(ov.x);
  });

  test('replaying a consumed revision fails closed', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const body = apply(o);
    expect((await api(request, 'proof-layout', o.orderId, body, o.token)).status).toBe(200);
    const after = overrideOf(readOrder(o.orderId));

    const replay = await api(request, 'proof-layout', o.orderId, body, o.token);
    expect(replay.status).toBe(409);
    expect(overrideOf(readOrder(o.orderId))).toEqual(after);
  });
});

// ── request help ─────────────────────────────────────────────────────────────

test.describe('request help', () => {
  test('records a durable audit event and is idempotent, with no side effects', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const first = await api(request, 'request-help', o.orderId, { pageIndex: 0 }, o.token);
    expect(first.status).toBe(200);
    expect(first.body.noop).toBe(false);

    const second = await api(request, 'request-help', o.orderId, { pageIndex: 0 }, o.token);
    expect(second.status).toBe(200);
    expect(second.body.noop).toBe(true);

    const after = readOrder(o.orderId);
    const events = (after.auditEvents ?? []).filter((e: any) => e.type === 'layout_help_requested');
    expect(events).toHaveLength(1);
    // Help must NOT advance the order or touch the proof.
    expect(after.reviewStatus).toBe('in_review');
    expect(after.proofVersion).toBe(o.proofVersion);
    expect(overrideOf(after)).toBeNull();
  });

  test('a nonexistent page index is refused without persistence', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'request-help', o.orderId, { pageIndex: 99 }, o.token);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((readOrder(o.orderId).auditEvents ?? [])).toHaveLength(0);
  });
});

// ── read-only fit route ──────────────────────────────────────────────────────

test.describe('authoritative fit route', () => {
  test('is side-effect free and reports the renderer decision', async ({ seed, api, request, readOrder }) => {
    const o = seed();
    const res = await api(request, 'proof-fit', o.orderId, apply(o), o.token);
    expect(res.status).toBe(200);
    expect(res.body.fit).toBeTruthy();
    expect(typeof res.body.fit.overflowed).toBe('boolean');

    const after = readOrder(o.orderId);
    expect(overrideOf(after)).toBeNull();
    expect(after.proofVersion).toBe(o.proofVersion);
    expect(after.proofSourceFingerprint).toBe(o.proofSourceFingerprint);
  });

  test('reports overflow for a tiny card and long text', async ({ seed, api, request }) => {
    const o = seed({ storyText: 'Overflowing sentence. '.repeat(120) });
    const res = await api(request, 'proof-fit', o.orderId,
      apply(o, { geometry: { ...ROOMY, width: BOUNDS.width.min, height: BOUNDS.height.min } }), o.token);
    expect(res.status).toBe(200);
    expect(res.body.fit.overflowed).toBe(true);
  });
});

// ── error hygiene ────────────────────────────────────────────────────────────

test.describe('error responses leak nothing', () => {
  test('no refusal echoes the token, story text, or internals', async ({ seed, api, request }) => {
    const o = seed({ storyText: 'CANARY_STORY_TEXT_do_not_leak.' });

    const refusals = await Promise.all([
      api(request, 'proof-layout', o.orderId, apply(o), 'z'.repeat(48)),
      api(request, 'proof-layout', o.orderId, apply(o, { geometry: { bad: 1 } }), o.token),
      api(request, 'proof-layout', o.orderId, apply(o, { authoredAgainstProofVersion: 'pv_x' }), o.token),
      api(request, 'proof-layout', o.orderId, apply(o, { pageIndex: 99 }), o.token),
      api(request, 'proof-layout', 'ord_missing_entirely', apply(o), o.token),
    ]);

    for (const r of refusals) {
      const raw = JSON.stringify(r.body ?? {});
      expect(raw).not.toContain(o.token);
      expect(raw).not.toContain('CANARY_STORY_TEXT');
      expect(raw).not.toContain('proofApprovalToken');
      expect(raw).not.toContain('synthetic@example.invalid');
      expect(raw).not.toMatch(/\/Users\/|\/var\/folders|src\/lib|node_modules/);
      expect(raw).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
      // Refusals are a bounded machine-readable code, not prose.
      expect(r.body.ok).toBe(false);
      expect(typeof r.body.error).toBe('string');
      expect(r.body.error.length).toBeLessThan(64);
    }
  });
});
