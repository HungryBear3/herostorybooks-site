import { journal, resetJournal } from './blob-store-fake.mjs';
import { uploadOrderDocument, uploadOrderVoice } from '../../src/lib/orders.ts';

const PUBLIC_TOKEN = 'vercel_blob_rw_pubstoretest_secretBBBBBBBB';
const PRIVATE_TOKEN = 'vercel_blob_rw_privstoretest_secretAAAAAAAA';

process.env.BLOB_READ_WRITE_TOKEN = PUBLIC_TOKEN;
process.env.HSB_PRIVATE_READ_WRITE_TOKEN = PRIVATE_TOKEN;
delete process.env.HSB_BLOB_ACCESS_MODE;
process.env.NODE_ENV = 'test';

/**
 * A file whose `arrayBuffer()` repoints the private store credential at the
 * PUBLIC store, mid-upload.
 *
 * Reading the file is the one await between "which store is this going to" and
 * the write itself. Whatever `put` is handed must have been decided before
 * that await, so a credential that drifts underneath cannot redirect consented
 * child audio into the public order store.
 */
function driftingFile(name, type) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => {
      process.env.HSB_PRIVATE_READ_WRITE_TOKEN = PUBLIC_TOKEN;
      return bytes.buffer;
    },
  };
}

resetJournal();
await uploadOrderVoice('ord_voice_access_race', driftingFile('voice.webm', 'audio/webm'));
process.env.HSB_PRIVATE_READ_WRITE_TOKEN = PRIVATE_TOKEN;
await uploadOrderDocument('ord_document_access_race', driftingFile('notes.pdf', 'application/pdf'));

process.stdout.write(JSON.stringify(journal.filter((entry) => entry.op === 'put')));
