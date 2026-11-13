import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BlobNotFoundError } from '@vercel/blob';
import {
  classifyBoundRecovery, classifyRecoveryProvenance, ensureBoundMarker, ensureProvenanceMarker, openProvenanceAccess,
  provenancePath, readBoundMarker, readProvenanceMarker,
} from '../src/lib/initial-shipping-provenance.ts';
import { createInitialShippingProvenanceAccess } from '../src/lib/orders.ts';
import { recoverOrder } from '../src/lib/order-recovery.ts';
import { NS, ORDER, fakeMarkerStore, synthOrderId } from './support/initial-shipping-fixture.ts';

test('marker: create-only exact body; lost response adopted by exact reread; outage/malformed are hold, never absence', async () => {
  const m = fakeMarkerStore();
  assert.equal(await readProvenanceMarker(m.store, NS, ORDER), 'absent');
  m.faults.createThrowAfter = true;
  assert.equal(await ensureProvenanceMarker(m.store, NS, ORDER), 'confirmed');
  assert.equal(await ensureProvenanceMarker(m.store, NS, ORDER), 'confirmed', 'idempotent, no overwrite');
  const other = synthOrderId('1');
  m.files.set(provenancePath(other, NS), '{"schema":"x"}');
  assert.equal(await readProvenanceMarker(m.store, NS, other), 'hold');
  m.faults.readThrow = true;
  assert.equal(await readProvenanceMarker(m.store, NS, ORDER), 'hold');
  assert.throws(() => provenancePath('ord_X', NS), /provenance_order_id_invalid/);
});

test('recoverOrder consults marker by input.id before any photo read/write, independent of supplied JSON fields', async () => {
  const m = fakeMarkerStore();
  await ensureProvenanceMarker(m.store, NS, ORDER);
  // photoFilePath points at a path that would throw if read; refusal must come first
  const input: any = { id: ORDER, childName: 'Synthetic', email: 'p@example.test', bookFormat: 'classic', photoFilePath: '/nonexistent/should-not-be-read.jpg' };
  await assert.rejects(recoverOrder(input, { provenanceStore: m.store, namespace: NS }), /initial_shipping_recovery_unsupported/);
  m.faults.readThrow = true;
  await assert.rejects(recoverOrder(input, { provenanceStore: m.store, namespace: NS }), /initial_shipping_provenance_hold/);
  // explicit injected null (unavailable) stays HOLD; omission selects production access (tests below)
  await assert.rejects(recoverOrder(input, { provenanceStore: null }), /initial_shipping_provenance_hold/);
  assert.deepEqual(await classifyRecoveryProvenance(fakeMarkerStore().store, NS, ORDER), { allow: true });
  assert.deepEqual(await classifyRecoveryProvenance(null, NS, 'ord_paid'), { allow: true }, 'non-canonical legacy id cannot carry a marker');
});

// ── Production access (SCOPE-ADMISSION): only env, filesystem and SDK transport are faked ──

const ENV_KEYS = ['BLOB_READ_WRITE_TOKEN', 'HSB_ORDER_STORE_DIR', 'HSB_BLOB_ACCESS_MODE', 'HSB_BLOB_NAMESPACE',
  'HSB_REQUIRE_DURABLE_PERSISTENCE', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV'] as const;
type EnvPatch = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
const ENV = process.env as Record<string, string | undefined>;
async function withEnv<T>(patch: EnvPatch, run: () => Promise<T>): Promise<T> {
  const old = ENV_KEYS.map((k) => [k, ENV[k]] as const);
  for (const k of ENV_KEYS) delete ENV[k];
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) ENV[k] = v;
  try { return await run(); } finally {
    for (const [k, v] of old) { if (v === undefined) delete ENV[k]; else ENV[k] = v; }
  }
}
const setEnv = (k: (typeof ENV_KEYS)[number], v: string | undefined) => { if (v === undefined) delete ENV[k]; else ENV[k] = v; };
async function tmpRoot() { return mkdtemp(path.join(os.tmpdir(), 'hsb-prov-')); }
const TOKEN_A = 'vercel_blob_rw_' + 'storeAAAA1' + '_' + 'secretsecret1';
const TOKEN_B = 'vercel_blob_rw_' + 'storeBBBB2' + '_' + 'secretsecret2';
const markerBody = (id: string) => JSON.stringify({ schema: 'hsb.initial-shipping-provenance.v1', orderId: id, operation: 'initial_checkout_shipping' });
const localMarkerFile = (root: string, ns: string, id: string) => path.join(root, 'order-provenance', 'initial-shipping', ns || '.flat', `${id}.json`);
async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out.push(path.relative(dir, p)); }
  };
  await walk(dir);
  return out.sort();
}
function spiedInput(id: string, photoPath: string) {
  const counts = { photoReads: 0 };
  const input: any = { id, childName: 'Synthetic', email: 'p@example.test', bookFormat: 'classic' };
  Object.defineProperty(input, 'photoFilePath', { enumerable: true, get() { counts.photoReads += 1; return photoPath; } });
  return { input, counts };
}

/** Synthetic Blob SDK transport (list/fetch/get/put) keyed by exact pathname; records every call. */
function fakeBlobTransport() {
  const objects = new Map<string, { body: string; etag: string }>();
  const calls: Array<{ op: string; pathname: string; opts?: any }> = [];
  const faults: { listThrow?: boolean; fetch404?: boolean; getThrow?: unknown; getNoStream?: boolean; putThrowBefore?: boolean; putThrowAfter?: boolean; pause?: Promise<void> } = {};
  let n = 0;
  const transport = {
    async list(opts: { prefix: string; token: string }) {
      calls.push({ op: 'list', pathname: opts.prefix, opts }); if (faults.pause) await faults.pause;
      if (faults.listThrow) throw new Error('synthetic metadata outage');
      const o = objects.get(opts.prefix);
      return { blobs: o ? [{ pathname: opts.prefix, url: `https://synthetic.invalid/${opts.prefix}`, downloadUrl: `https://synthetic.invalid/${opts.prefix}?download=1`, etag: o.etag }] : [] } as never;
    },
    async fetch(url: URL | string) {
      const u = new URL(String(url)); const p = u.pathname.slice(1); calls.push({ op: 'fetch', pathname: p });
      const o = objects.get(p);
      if (!o || faults.fetch404) return new Response('', { status: 404 });
      return new Response(o.body, { status: 200, headers: { etag: o.etag } });
    },
    async get(pathname: string, opts: any) {
      calls.push({ op: 'get', pathname, opts }); if (faults.pause) await faults.pause;
      if (faults.getThrow) throw faults.getThrow;
      const o = objects.get(pathname);
      if (!o) return null;
      if (faults.getNoStream) return { blob: { etag: o.etag } } as never;
      return { stream: new Response(o.body).body, blob: { etag: o.etag } } as never;
    },
    async put(pathname: string, body: string, opts: any) {
      calls.push({ op: 'put', pathname, opts }); if (faults.pause) await faults.pause;
      if (faults.putThrowBefore) throw new Error('synthetic ambiguous');
      if (objects.has(pathname)) throw new Error('Vercel Blob: This blob already exists');
      objects.set(pathname, { body, etag: `"e${++n}"` });
      if (faults.putThrowAfter) throw new Error('synthetic lost response');
      return { pathname, etag: `"e${n}"` } as never;
    },
  };
  return { transport, objects, calls, faults };
}

test('production provenance: default canonical recovery permits true absence without injected store', async () => {
  const root = await tmpRoot();
  try {
    await withEnv({ HSB_ORDER_STORE_DIR: root, HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
      const id = synthOrderId('b');
      const summary = await recoverOrder({ id, childName: 'Synthetic', email: 'p@example.test', bookFormat: 'digital' } as any);
      assert.equal(summary.orderId, id);
      assert.equal(summary.paymentStatus, 'paid');
      const record = JSON.parse(await readFile(path.join(root, `${id}.json`), 'utf8'));
      assert.equal(record.id, id);
      assert.equal(record.paymentStatus, 'paid');
      assert.equal(record.fulfillmentMode, 'manual_hold');
      assert.deepEqual(await listTree(root), [`${id}.json`], 'marker untouched: recovery never creates provenance');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production provenance: default canonical recovery refuses present and unknown before photo or write', async () => {
  const root = await tmpRoot();
  try {
    await withEnv({ HSB_ORDER_STORE_DIR: root, HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
      const photo = path.join(root, 'photo-source.jpg');
      await writeFile(photo, 'synthetic-photo');
      const cases: Array<[string, string | null, RegExp]> = [
        ['present', markerBody(synthOrderId('c')), /initial_shipping_recovery_unsupported/],
        ['malformed', '{not json', /initial_shipping_provenance_hold/],
        ['wrong id', markerBody(synthOrderId('d')), /initial_shipping_provenance_hold/],
        ['wrong schema', JSON.stringify({ schema: 'x', orderId: synthOrderId('c'), operation: 'initial_checkout_shipping' }), /initial_shipping_provenance_hold/],
        ['wrong operation', JSON.stringify({ schema: 'hsb.initial-shipping-provenance.v1', orderId: synthOrderId('c'), operation: 'x' }), /initial_shipping_provenance_hold/],
        ['extra field', JSON.stringify({ schema: 'hsb.initial-shipping-provenance.v1', orderId: synthOrderId('c'), operation: 'initial_checkout_shipping', extra: 1 }), /initial_shipping_provenance_hold/],
      ];
      for (const [label, body, expected] of cases) {
        const id = synthOrderId('c');
        const file = localMarkerFile(root, 'nsA', id);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, body!);
        const { input, counts } = spiedInput(id, photo);
        await assert.rejects(recoverOrder(input), expected, label);
        assert.equal(counts.photoReads, 0, `${label}: zero photo reads`);
        await assert.rejects(readFile(path.join(root, `${id}.json`), 'utf8'), /ENOENT/, `${label}: zero order persistence`);
        await rm(file);
      }
      // unreadable marker (a directory at the marker path => EISDIR) is HOLD, not absence
      const id = synthOrderId('e');
      await mkdir(localMarkerFile(root, 'nsA', id), { recursive: true });
      const { input, counts } = spiedInput(id, photo);
      await assert.rejects(recoverOrder(input), /initial_shipping_provenance_hold/);
      assert.equal(counts.photoReads, 0);
      await assert.rejects(readFile(path.join(root, `${id}.json`), 'utf8'), /ENOENT/);
    });
    // unavailable access (invalid namespace configuration) holds with zero effects
    await withEnv({ HSB_ORDER_STORE_DIR: root, HSB_BLOB_NAMESPACE: '../escape' }, async () => {
      const { input, counts } = spiedInput(synthOrderId('f'), '/nonexistent.jpg');
      await assert.rejects(recoverOrder(input), /initial_shipping_provenance_hold/);
      assert.equal(counts.photoReads, 0);
    });
    // incomplete private response (nonnull without stream) holds
    await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'private', HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
      const t = fakeBlobTransport();
      t.objects.set(provenancePath(ORDER, 'nsA'), { body: markerBody(ORDER), etag: '"e1"' });
      t.faults.getNoStream = true;
      assert.equal(await classifyBoundRecovery(createInitialShippingProvenanceAccess(t.transport), ORDER)
        .then((r) => ('code' in r ? r.code : 'allow')), 'initial_shipping_provenance_hold');
      t.faults.getNoStream = false;
      assert.deepEqual(await classifyBoundRecovery(createInitialShippingProvenanceAccess(t.transport), ORDER),
        { allow: false, code: 'initial_shipping_recovery_unsupported' });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production provenance: marker and order occupy distinct local paths', async () => {
  const root = await tmpRoot();
  try {
    const id = synthOrderId('a');
    const orderBytes = JSON.stringify({ id, synthetic: 'order-record' });
    await writeFile(path.join(root, `${id}.json`), orderBytes);
    await withEnv({ HSB_ORDER_STORE_DIR: root }, async () => {
      // order seeded first: marker is absent (the order is not misread as a malformed marker)
      const flat = createInitialShippingProvenanceAccess();
      assert.equal(flat.namespace, '');
      assert.equal(await readBoundMarker(flat, id), 'absent');
      assert.equal(await ensureBoundMarker(flat, id), 'confirmed');
      assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8'), orderBytes, 'order bytes unchanged');
      assert.equal(await readFile(localMarkerFile(root, '', id), 'utf8'), markerBody(id));
      // concurrent create converges on one exact marker without overwrite
      const id2 = synthOrderId('9');
      const results = await Promise.all([ensureBoundMarker(flat, id2), ensureBoundMarker(flat, id2), ensureBoundMarker(flat, id2)]);
      assert.deepEqual(results, ['confirmed', 'confirmed', 'confirmed']);
      // marker first, then the order record: the record does not see the marker
      await writeFile(path.join(root, `${id2}.json`), orderBytes);
      assert.equal(await readFile(localMarkerFile(root, '', id2), 'utf8'), markerBody(id2));
      // preexisting malformed marker is never overwritten and holds
      const id3 = synthOrderId('8');
      await mkdir(path.dirname(localMarkerFile(root, '', id3)), { recursive: true });
      await writeFile(localMarkerFile(root, '', id3), '{"schema":"tampered"}');
      assert.equal(await ensureBoundMarker(flat, id3), 'hold');
      assert.equal(await readFile(localMarkerFile(root, '', id3), 'utf8'), '{"schema":"tampered"}');
    });
    for (const ns of ['nsA', 'nsB']) {
      await withEnv({ HSB_ORDER_STORE_DIR: root, HSB_BLOB_NAMESPACE: ns }, async () => {
        const access = createInitialShippingProvenanceAccess();
        assert.equal(access.namespace, ns);
        assert.equal(await readBoundMarker(access, id), 'absent', `${ns} separated from flat and the other namespace`);
        assert.equal(await ensureBoundMarker(access, id), 'confirmed');
      });
    }
    assert.deepEqual(await listTree(root), [
      `${synthOrderId('9')}.json`, `${id}.json`,
      `order-provenance/initial-shipping/.flat/${synthOrderId('8')}.json`,
      `order-provenance/initial-shipping/.flat/${synthOrderId('9')}.json`,
      `order-provenance/initial-shipping/.flat/${id}.json`,
      `order-provenance/initial-shipping/nsA/${id}.json`,
      `order-provenance/initial-shipping/nsB/${id}.json`,
    ].sort(), 'no temporary siblings left; marker never becomes an order record');
    assert.equal(await readFile(path.join(root, `${id}.json`), 'utf8'), orderBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production provenance: create uncertainty requires exact reread', async () => {
  await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'private' }, async () => {
    const p = provenancePath(ORDER, '');
    const run = async (setup: (t: ReturnType<typeof fakeBlobTransport>) => void) => {
      const t = fakeBlobTransport(); setup(t);
      return { r: await ensureBoundMarker(createInitialShippingProvenanceAccess(t.transport), ORDER), t };
    };
    assert.equal((await run(() => {})).r, 'confirmed', 'success + exact reread');
    assert.equal((await run((t) => { t.faults.putThrowAfter = true; })).r, 'confirmed', 'throw-after adopted by exact reread');
    assert.equal((await run((t) => { t.objects.set(p, { body: markerBody(ORDER), etag: '"x"' }); })).r, 'confirmed', 'conflict + exact marker');
    assert.equal((await run((t) => { t.faults.putThrowBefore = true; })).r, 'hold', 'throw-before + absent reread holds');
    const unreadable = await run((t) => { t.faults.putThrowAfter = true; t.faults.getThrow = new Error('outage'); });
    assert.equal(unreadable.r, 'hold');
    const wrong = await run((t) => { t.objects.set(p, { body: markerBody(synthOrderId('1')), etag: '"x"' }); });
    assert.equal(wrong.r, 'hold', 'wrong body holds');
    assert.equal(wrong.t.objects.get(p)!.body, markerBody(synthOrderId('1')), 'never overwritten');
    const ok = await run(() => {});
    const put = ok.t.calls.find((c) => c.op === 'put')!;
    assert.equal(put.pathname, p);
    assert.equal(put.opts.allowOverwrite, false);
    assert.equal(put.opts.access, 'private');
    assert.equal(put.opts.token, TOKEN_A);
    assert.equal(ok.t.calls.filter((c) => c.op === 'put').length, 1, 'no retry/overwrite/delete');
  });
});

test('production provenance: bound context drift holds without cross-store effects', async () => {
  // stable positive controls: private, public, local
  await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'private', HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
    const t = fakeBlobTransport();
    assert.equal(await ensureBoundMarker(createInitialShippingProvenanceAccess(t.transport), ORDER), 'confirmed');
  });
  await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'public', HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
    const t = fakeBlobTransport();
    assert.equal(await ensureBoundMarker(createInitialShippingProvenanceAccess(t.transport), ORDER), 'confirmed');
    assert.ok(t.calls.every((c) => c.op !== 'get'), 'public mode never uses authenticated private get');
  });
  const rotations: Array<[string, () => void]> = [
    ['namespace', () => setEnv('HSB_BLOB_NAMESPACE', 'nsB')],
    ['token/store', () => setEnv('BLOB_READ_WRITE_TOKEN', TOKEN_B)],
    ['access mode', () => setEnv('HSB_BLOB_ACCESS_MODE', 'public')],
  ];
  for (const [label, rotate] of rotations) {
    await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'private', HSB_BLOB_NAMESPACE: 'nsA' }, async () => {
      const t = fakeBlobTransport();
      let release!: () => void; t.faults.pause = new Promise<void>((r) => { release = r; });
      const access = createInitialShippingProvenanceAccess(t.transport);
      const pending = ensureBoundMarker(access, ORDER);
      await new Promise((r) => setImmediate(r));
      rotate(); release();
      assert.equal(await pending, 'hold', `${label} drift holds`);
      assert.ok(t.calls.length > 0);
      for (const c of t.calls) {
        assert.equal(c.pathname, provenancePath(ORDER, 'nsA'), `${label}: captured path only`);
        if (c.opts?.token) assert.equal(c.opts.token, TOKEN_A, `${label}: captured token only`);
        if (c.opts?.access) assert.equal(c.opts.access, 'private', `${label}: captured mode only`);
      }
      assert.equal(await classifyBoundRecovery(access, ORDER).then((r) => ('code' in r ? r.code : 'allow')), 'initial_shipping_provenance_hold');
    });
  }
  const rootA = await tmpRoot(); const rootB = await tmpRoot();
  try {
    await withEnv({ HSB_ORDER_STORE_DIR: rootA }, async () => {
      const access = createInitialShippingProvenanceAccess();
      assert.equal(await ensureBoundMarker(access, ORDER), 'confirmed', 'local stable positive');
      setEnv('HSB_ORDER_STORE_DIR', rootB);
      assert.equal(await readBoundMarker(access, ORDER), 'hold', 'local root drift holds');
      // recovery effect after drift is refused: no write in either root
      const { input } = spiedInput(synthOrderId('7'), '/nonexistent.jpg');
      setEnv('HSB_ORDER_STORE_DIR', rootA);
      const recovering = recoverOrder({ ...input, photoFilePath: undefined, bookFormat: 'digital' });
      setEnv('HSB_ORDER_STORE_DIR', rootB);
      await assert.rejects(recovering, /initial_shipping_provenance_hold/);
    });
    assert.deepEqual(await listTree(rootB), [], 'no effect in the replacement context');
    assert.ok(!(await listTree(rootA)).includes(`${synthOrderId('7')}.json`), 'no recovery write after drift');
  } finally { await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); }
});

test('production provenance: production missing token never falls back locally', async () => {
  const root = await tmpRoot();
  try {
    const envs: EnvPatch[] = [
      { HSB_ORDER_STORE_DIR: root, VERCEL: '1', HSB_BLOB_NAMESPACE: 'nsA' },
      { HSB_ORDER_STORE_DIR: root, NODE_ENV: 'production' },
      { HSB_ORDER_STORE_DIR: root, HSB_REQUIRE_DURABLE_PERSISTENCE: 'true' },
      { HSB_ORDER_STORE_DIR: root, VERCEL: '1', HSB_REQUIRE_DURABLE_PERSISTENCE: 'false', HSB_BLOB_NAMESPACE: 'nsA' },
      { HSB_ORDER_STORE_DIR: root, NODE_ENV: 'production', HSB_REQUIRE_DURABLE_PERSISTENCE: 'false' },
      { HSB_ORDER_STORE_DIR: root, BLOB_READ_WRITE_TOKEN: 'not-a-valid-token' },
    ];
    for (const env of envs) {
      await withEnv(env, async () => {
        assert.throws(() => createInitialShippingProvenanceAccess(), /initial_shipping_provenance_unavailable/, JSON.stringify(env));
        assert.equal(openProvenanceAccess(), null);
        const { input, counts } = spiedInput(synthOrderId('6'), '/nonexistent.jpg');
        await assert.rejects(recoverOrder(input), /initial_shipping_provenance_hold/);
        assert.equal(counts.photoReads, 0);
      });
    }
    assert.deepEqual(await listTree(root), [], 'zero filesystem effects');
    await withEnv({ HSB_ORDER_STORE_DIR: root }, async () => {
      const access = createInitialShippingProvenanceAccess();
      await assert.rejects(access.read('ord_X'), /initial_shipping_provenance_invalid/);
      await assert.rejects(access.read('../' + ORDER), /initial_shipping_provenance_invalid/);
      await assert.rejects(access.create(ORDER, '{"schema":"x"}'), /initial_shipping_provenance_invalid/);
      await assert.rejects(access.create(ORDER, markerBody(synthOrderId('1'))), /initial_shipping_provenance_invalid/);
      assert.deepEqual(await listTree(root), [], 'invalid id/body rejected before I/O');
      assert.equal(await ensureBoundMarker(access, ORDER), 'confirmed', 'genuine local/dev positive control');
      assert.equal(Object.keys(access).sort().join(','), 'create,intact,kind,namespace,read', 'no adapter/replace/delete/token exposure');
      assert.ok(!JSON.stringify(access).includes('secret'));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production provenance: arbitrary not-found text and CDN 404 never establish absence', async () => {
  await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'private' }, async () => {
    const t = fakeBlobTransport();
    const access = createInitialShippingProvenanceAccess(t.transport);
    t.faults.getThrow = new Error('Vercel Blob: 404 The requested blob does not exist (not found)');
    assert.equal(await readBoundMarker(access, ORDER), 'hold', 'generic not-found text holds');
    t.faults.getThrow = new BlobNotFoundError();
    assert.equal(await readBoundMarker(access, ORDER), 'absent', 'typed SDK not-found is synthetic absence');
    t.faults.getThrow = undefined;
    assert.equal(await readBoundMarker(access, ORDER), 'absent', 'typed null result is synthetic absence');
    const get = t.calls.find((c) => c.op === 'get')!;
    assert.deepEqual({ access: get.opts.access, token: get.opts.token, useCache: get.opts.useCache }, { access: 'private', token: TOKEN_A, useCache: false });
  });
  await withEnv({ BLOB_READ_WRITE_TOKEN: TOKEN_A, HSB_BLOB_ACCESS_MODE: 'public' }, async () => {
    const t = fakeBlobTransport();
    const access = createInitialShippingProvenanceAccess(t.transport);
    t.faults.listThrow = true;
    assert.equal(await readBoundMarker(access, ORDER), 'hold', 'authenticated metadata failure holds');
    t.faults.listThrow = false;
    t.objects.set(provenancePath(ORDER, ''), { body: markerBody(ORDER), etag: '"e1"' });
    t.faults.fetch404 = true;
    assert.equal(await readBoundMarker(access, ORDER), 'hold', 'metadata present + CDN 404 holds');
    t.faults.fetch404 = false;
    assert.equal(await readBoundMarker(access, ORDER), 'present');
    t.objects.clear();
    assert.equal(await readBoundMarker(access, ORDER), 'absent', 'exact-path metadata absence is synthetic absence only');
  });
});
