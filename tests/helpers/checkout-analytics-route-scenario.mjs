/**
 * Drives the REAL `/api/order` route on the legacy path with the bounded
 * checkout analytics fields and prints what the route did — status, body, and
 * the journal of every external surface, including the Stripe Session metadata
 * the route adapter built.
 *
 * Run in a child process with order-route-register.mjs installed (next/server,
 * stripe and @vercel/blob are journalled fakes). Everything is synthetic: an
 * in-memory versioned order store, no Stripe account, no customer, no network.
 *
 * The order store is the in-memory adapter the handler suite uses, installed
 * through the real module's test seam, because the local file adapter keys
 * records by basename and the intent reservation shares the order's basename.
 */
import { journal } from './order-route-fakes/journal.mjs';
import { __setOrderStoreAdapterFactoryForTests } from '../../src/lib/orders.ts';

const cells = new Map();
__setOrderStoreAdapterFactoryForTests(() => ({
  kind: 'test-memory',
  async readVersioned(pathname) {
    const cell = cells.get(pathname);
    return cell ? { body: cell.body, version: String(cell.version) } : null;
  },
  async createIfAbsent(pathname, body) {
    if (cells.has(pathname)) return { ok: false, reason: 'exists' };
    cells.set(pathname, { body, version: 1 });
    return { ok: true, version: '1' };
  },
  async replaceIfVersion(pathname, body, expectedVersion) {
    const cell = cells.get(pathname);
    if (!cell || String(cell.version) !== expectedVersion) return { ok: false, reason: 'version_conflict' };
    cell.body = body;
    cell.version += 1;
    return { ok: true, version: String(cell.version) };
  },
}));

const DAY = 86_400_000;
const attemptId = 'c'.repeat(32);
const capturedAgo = (ms) => new Date(Date.now() - ms).toISOString();
const state = {
  version: 1,
  firstTouch: {
    source: 'facebook', medium: 'paid_social', campaign: '2026-10-gifts', content: null, term: null,
    landingPath: '/gifts/birthdays', capturedAt: capturedAgo(3 * DAY),
  },
  lastNonDirectTouch: {
    source: 'newsletter', medium: 'email', campaign: null, content: null, term: null,
    landingPath: '/', capturedAt: capturedAgo(DAY),
  },
};

const form = new FormData();
form.set('checkoutAttemptId', attemptId);
form.set('childName', 'Mina');
form.set('email', 'buyer@example.test');
form.set('theme', 'space-adventure');
form.set('bookFormat', 'digital');
form.set('characterNotes', 'Curly hair, red cape');
form.set('gaClientId', '123456789.1727500000');
form.set('gaSessionId', '1727500000');
form.set('gaSessionNumber', '3');
form.set('attribution', JSON.stringify(state));
// A raw campaign parameter posted as its own field must never reach Stripe.
form.set('utm_source', 'ZQX-RAW-QUERY');

const { POST } = await import('../../src/app/api/order/route.ts');
const response = await POST(new Request('https://herostorybooks.com/api/order', {
  method: 'POST',
  body: form,
}));

let body;
try { body = await response.json(); } catch { body = null; }

process.stdout.write(`__SCENARIO_JSON__${JSON.stringify({
  status: response.status,
  body,
  attemptId,
  state,
  journal,
})}__END__\n`);
