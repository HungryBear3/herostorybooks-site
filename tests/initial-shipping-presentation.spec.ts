// Direct React SSR of actual routes. JSX transform only; not a TypeScript diagnostic gate.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
registerHooks({
  resolve(specifier, context, next) {
    if (/^next\/(navigation|link|headers)$/.test(specifier)) return next(specifier + '.js', context);
    if (specifier.startsWith('@/') || (specifier.startsWith('.') && context.parentURL?.includes('/src/'))) {
      const base = specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2)) : fileURLToPath(new URL(specifier, context.parentURL));
      for (const suffix of ['', '.ts', '.tsx']) if (existsSync(base + suffix) && /\.(ts|tsx)$/.test(base + suffix)) return next(pathToFileURL(base + suffix).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return next(url, context);
  },
});
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh() {} }), notFound: () => { throw new Error('NOT_FOUND'); } } });
let cookie = 'hsb-ops-key=synthetic-admin';
mock.module('next/headers', { namedExports: { headers: async () => new Headers({ cookie }) } });
const realBlob = await import('@vercel/blob');
let files: Map<string, { body: string; version: number }>;
const deny = async () => { throw new Error('UNMATCHED_EXTERNAL_IO'); };
mock.module('@vercel/blob', { namedExports: { ...realBlob, head: deny, list: deny, put: deny, del: deny,
  get: async (p: string) => { const f = files.get(p); return f ? { stream: new Response(f.body).body, blob: { etag: String(f.version) } } : null; } } });
const { syntheticOrderBlob, presentationOrder, withLuluEnv, synthOrderId } = await import('./support/initial-shipping-fixture.ts');
const { default: ThankYou } = await import('../src/app/thank-you/page.tsx');
const { default: AdminDetail } = await import('../src/app/admin/orders/[orderId]/page.tsx');
const { default: StatusPage } = await import('../src/app/status/[orderId]/page.tsx');

 test('actual linked status renderer holds unknown print outcomes without claiming production', async () => {
  const env = { ...process.env }; const s = syntheticOrderBlob(); files = s.files;
  Object.assign(process.env, { HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticOrders_syntheticSecret', HSB_BLOB_ACCESS_MODE: 'private' });
  try { await withLuluEnv(async () => {
    for (const [i, mode] of ['lost-response', 'failed-bind', 'paid-hold', 'standard'].entries()) {
      const o = await presentationOrder(s, synthOrderId(String(i + 5)), true);
      await withOrderTransaction(o.id, current => {
        const n = { ...current, fulfillmentStatus: 'submitting_to_print' as const,
          printSubmissionAttemptedAt: new Date().toISOString(), printJobId: null };
        if (mode === 'paid-hold') n.fulfillmentLastError = 'shipping_hold:dispatch_cost_exceeded';
        if (mode === 'standard') { delete n.initialShipping; delete n.initialShippingSettlement; }
        return { commit: n, result: true };
      });
      const html = renderToStaticMarkup(await StatusPage({ params: Promise.resolve({ orderId: o.id }) }));
      if (mode === 'standard') assert.match(html, /Your book is being printed/);
      else {
        assert.match(html, /Payment received/); assert.match(html, /print.*review|print.*confirm/i);
        assert.doesNotMatch(html, /Your book is being printed|manufacturing your book|Handing the approved proof|moving to print/);
        assert.doesNotMatch(html, /Synthetic Recipient|123 Example|receiptDigest|draftRef|accountBinding/);
      }
    }
  }); } finally { s.close(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
});

const { withOrderTransaction } = await import('../src/lib/orders.ts');

test('actual thank-you React render: committed upgrade, paid hold, pending quote, and standard', async () => {
  const env = { ...process.env }; const s = syntheticOrderBlob(); files = s.files;
  Object.assign(process.env, { HSB_ORDER_ADMIN_KEY: 'synthetic-admin', HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticOrders_syntheticSecret', HSB_BLOB_ACCESS_MODE: 'private' });
  try { await withLuluEnv(async () => {
    for (const [i, mode] of ['committed', 'held', 'pending', 'standard'].entries()) {
      const o = await presentationOrder(s, synthOrderId(String(i)), mode !== 'pending');
      if (mode === 'held') await withOrderTransaction(o.id, current => ({ commit: { ...current, fulfillmentLastError: 'print_submission_failed_before_attempt: shipping_hold:dispatch_cost_exceeded' }, result: true }));
      if (mode === 'standard') await withOrderTransaction(o.id, current => { const n = { ...current }; delete n.initialShipping; delete n.initialShippingSettlement; return { commit: n, result: true }; });
      const html = renderToStaticMarkup(await ThankYou({ searchParams: Promise.resolve({ orderId: o.id }) }));
      const props = { params: Promise.resolve({ orderId: o.id }), searchParams: Promise.resolve({}) };
      const admin = renderToStaticMarkup(await AdminDetail(props));
      if (mode !== 'standard') {
        assert.match(admin, /Initial shipping upgrade/);
        assert.match(admin, /Accepted quote/);
        if (mode === 'held') assert.match(admin, /dispatch_cost_exceeded/);
        assert.doesNotMatch(admin, /Synthetic Recipient|123 Example|receiptDigest|draftRef|accountBinding/);
      }
      cookie = '';
      assert.match(renderToStaticMarkup(await AdminDetail(props)), /Sign in first/);
      cookie = 'hsb-ops-key=synthetic-admin';
      if (mode === 'standard') { assert.match(html, /Storybook Is In Motion/); assert.doesNotMatch(html, /Accepted quote/); }
      else {
        assert.match(html, /Accepted quote/); assert.match(html, /\$44\.19/);
        assert.doesNotMatch(html, /Synthetic Recipient|123 Example|draftRef|receiptDigest|accountBinding/);
        if (mode === 'committed') assert.match(html, /Expedited shipping upgrade paid/);
        if (mode === 'held') { assert.match(html, /Payment received/); assert.doesNotMatch(html, /Storybook Is In Motion|A confirmation was sent/); }
        if (mode === 'pending') { assert.match(html, /Checking your payment/); assert.doesNotMatch(html, /upgrade paid/); }
      }
    }
  }); } finally { s.close(); for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
});
