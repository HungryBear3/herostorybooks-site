/**
 * Drives the real upload and rollback code against the two-store Blob fake so
 * a test can prove WHICH store each object lands in — Custom Story media in the
 * dedicated private store, customer photos in the legacy public one — without a
 * network, a deployment, or a real credential.
 *
 * The environment below is the PRODUCTION shape, and that is the point: both
 * Blob tokens set, and no `HSB_BLOB_ACCESS_MODE` anywhere. The fake models the
 * constraint that caused the regression — a store whose id starts `pub`
 * rejects an `access: 'private'` write — so a voice or document upload still
 * addressing the public order store fails here instead of passing quietly.
 *
 * The tokens below are synthetic. The fake parses a store id out of them and
 * journals only that id, never the value.
 */
import sharp from 'sharp';

import { journal, pathnamesIn, resetJournal } from './blob-store-fake.mjs';
import {
  rollbackOrderMediaUploads,
  uploadOrderDocument,
  uploadOrderPhoto,
  uploadOrderSupportingPhoto,
  uploadOrderVoice,
} from '../../src/lib/orders.ts';

process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_pubstoretest_secretBBBBBBBB';
process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'vercel_blob_rw_privstoretest_secretAAAAAAAA';
// Production shape: no global private access mode anywhere.
delete process.env.HSB_BLOB_ACCESS_MODE;
delete process.env.HSB_BLOB_NAMESPACE;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
process.env.NODE_ENV = 'test';

export const PUBLIC_STORE = 'pubstoretest';
export const PRIVATE_STORE = 'privstoretest';

const ORDER_ID = 'ord_store_routing';

function fileFrom(bytes, name, type) {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function jpegFile() {
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#ffffff' },
  }).jpeg().toBuffer();
  return new File([bytes], 'child.jpg', { type: 'image/jpeg' });
}

const out = { steps: {}, journal: [], stores: {} };

async function step(name, fn) {
  try {
    out.steps[name] = { ok: true, value: await fn() };
  } catch (err) {
    out.steps[name] = {
      ok: false,
      error: { name: err?.name ?? 'unknown', message: String(err?.message ?? '') },
    };
  }
}

resetJournal();

const voice = await uploadOrderVoice(ORDER_ID, fileFrom(new Uint8Array([1, 2, 3, 4]), 'voice.webm', 'audio/webm'));
const document = await uploadOrderDocument(ORDER_ID, fileFrom(new Uint8Array([5, 6, 7, 8]), 'notes.pdf', 'application/pdf'));
const photo = await uploadOrderPhoto(ORDER_ID, await jpegFile());
const supporting = await uploadOrderSupportingPhoto(ORDER_ID, 0, await jpegFile());

if (!voice || !document || !photo || !supporting) {
  throw new Error('every upload must return a durable reference in this scenario');
}

/**
 * A MIXED rollback: two objects in the public order store and two in the
 * private story-media store, handed to one call exactly as the legacy checkout
 * route hands them over.
 */
await step('rollbackMixed', () =>
  rollbackOrderMediaUploads(ORDER_ID, [
    photo.pathname,
    supporting.pathname,
    voice.pathname,
    document.pathname,
  ]),
);

await step('rollbackUnclassifiable', () =>
  rollbackOrderMediaUploads(ORDER_ID, [`orders/${ORDER_ID}/mystery-object.bin`]),
);

out.journal = journal;
out.stores = {
  [PUBLIC_STORE]: pathnamesIn(PUBLIC_STORE),
  [PRIVATE_STORE]: pathnamesIn(PRIVATE_STORE),
  unresolved: pathnamesIn('unresolved'),
  unparseable: pathnamesIn('unparseable'),
};

process.stdout.write(`\n__SCENARIO_JSON__${JSON.stringify(out)}__END__\n`);
