import { journal, resetJournal } from './blob-store-fake.mjs';
import { uploadOrderDocument, uploadOrderVoice } from '../../src/lib/orders.ts';

process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_privstore_testonly';
process.env.HSB_BLOB_ACCESS_MODE = 'private';
process.env.NODE_ENV = 'test';

function driftingFile(name, type) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => {
      process.env.HSB_BLOB_ACCESS_MODE = 'public';
      return bytes.buffer;
    },
  };
}

resetJournal();
await uploadOrderVoice('ord_voice_access_race', driftingFile('voice.webm', 'audio/webm'));
process.env.HSB_BLOB_ACCESS_MODE = 'private';
await uploadOrderDocument('ord_document_access_race', driftingFile('notes.pdf', 'application/pdf'));

process.stdout.write(JSON.stringify(journal.filter((entry) => entry.op === 'put')));
