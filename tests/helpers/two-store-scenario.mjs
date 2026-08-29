/**
 * Scenario runner for the two-store isolation harness.
 *
 * Runs in a CHILD process with `@vercel/blob` swapped for the two-store
 * fake (see blob-fake-register.mjs). It drives the REAL src/ modules —
 * store.ts, private-assets.ts, orders.ts — and prints a JSON journal of
 * every store call the run produced, plus the values those functions
 * returned. tests/family-review-two-store-isolation.test.ts asserts on
 * that journal.
 *
 * A child process rather than in-process mocking because the resolve
 * hook has to be installed before any module that imports
 * `@vercel/blob` is loaded, and because it guarantees one scenario's env
 * cannot leak into the next.
 *
 * Every value here is synthetic. No live store, no customer record, no
 * real credential.
 */

/** Fake credentials. Parseable, obviously fake, and never real. */
const AMBIENT_TOKEN = 'vercel_blob_rw_pubAMBIENT0000_ambientsecret';
const DEST_TOKEN = 'vercel_blob_rw_privDEST0000_destsecret';
const ALIAS_TOKEN = 'vercel_blob_rw_pubAMBIENT0000_differentsecret';
export const AMBIENT_STORE = 'pubAMBIENT0000';
export const DEST_STORE = 'privDEST0000';

const scenario = process.argv[2];

const env = {
  BLOB_READ_WRITE_TOKEN: AMBIENT_TOKEN,
  HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
  FAMILY_REVIEW_ADMIN_KEY: 'not-a-real-admin-key',
};

switch (scenario) {
  case 'private-ok':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = DEST_TOKEN;
    break;
  case 'private-missing-token':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    break;
  case 'private-blank-token':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = '   ';
    break;
  case 'private-malformed-token':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = 'not-a-blob-token';
    break;
  case 'private-alias-token':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = ALIAS_TOKEN;
    break;
  case 'public-mode':
    break;
  case 'private-read-miss-legacy-on':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = DEST_TOKEN;
    env.FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS = '1';
    break;
  case 'private-read-miss-legacy-off':
    env.FAMILY_REVIEW_BLOB_ACCESS = 'private';
    env.FAMILY_REVIEW_DEST_BLOB_TOKEN = DEST_TOKEN;
    env.FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS = '0';
    break;
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}
Object.assign(process.env, env);

/* Loaded AFTER the env is in place, and after the resolve hook. */
const fake = await import('./blob-store-fake.mjs');
const store = await import('../../src/lib/family-review/store.ts');
const assets = await import('../../src/lib/family-review/private-assets.ts');
const orders = await import('../../src/lib/orders.ts');

const out = { scenario, steps: {}, journal: [], stores: {} };

/** Run one labelled step, capturing its return value or its failure. */
async function step(name, fn) {
  try {
    out.steps[name] = { ok: true, value: await fn() };
  } catch (err) {
    out.steps[name] = {
      ok: false,
      error: { name: err?.name ?? 'unknown', code: err?.code ?? null, message: String(err?.message ?? '') },
    };
  }
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const submission = {
  id: 'fr-synthetic-1',
  reviewTokenHash: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  parentEmail: 'synthetic@example.invalid',
  childFirstName: 'Synthetic',
  photos: { assets: [] },
  samples: [],
};

await step('hasBlobToken', () => store.hasBlobToken());

await step('persistSubmission', () => store.persistSubmission(submission));

/* Real pathname helpers, so the harness exercises the real layout:
   records under family-review/submissions/, bytes under
   family-review/photos/ and family-review/samples/. */
const PHOTO_PATH = store.photoPath('fr-synthetic-1', 'p1', 'png');
const SAMPLE_PATH = store.samplePath('fr-synthetic-1', 's1', 'png');

await step('putPhotoAsset', () =>
  assets.putAsset({ pathname: PHOTO_PATH, bytes: PNG, mime: 'image/png' }),
);

await step('putSampleAsset', () =>
  assets.putAsset({ pathname: SAMPLE_PATH, bytes: PNG, mime: 'image/png' }),
);

await step('listRecentSubmissions', async () =>
  (await store.listRecentSubmissions(10)).map((s) => s.id),
);

await step('findById', async () => (await store.findById('fr-synthetic-1'))?.id ?? null);

await step('openPrivateAsset', async () => {
  const opened = await assets.openAsset({
    blobPathname: PHOTO_PATH,
    storage: 'private',
    mime: 'image/png',
  });
  return { storage: opened.storage, size: opened.size };
});

await step('openMissingPrivateAsset', async () => {
  const opened = await assets.openAsset({
    blobPathname: store.photoPath('fr-synthetic-1', 'absent', 'png'),
    storage: 'private',
    mime: 'image/png',
  });
  return { storage: opened.storage };
});

await step('readMissingRecord', () =>
  store.findById('fr-absent-record').then((r) => r?.id ?? null),
);

await step('deleteAsset', () => assets.deleteAsset(PHOTO_PATH));

/* The other lanes: they must stay exactly where they were. */
await step('persistOrder', async () => {
  const saved = await orders.persistOrder({
    id: 'ord_synthetic_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'created',
  });
  return saved?.id ?? null;
});

await step('getOrder', async () => (await orders.getOrder('ord_synthetic_1'))?.id ?? null);

out.journal = fake.journal;
out.stores = {
  [AMBIENT_STORE]: fake.pathnamesIn(AMBIENT_STORE),
  [DEST_STORE]: fake.pathnamesIn(DEST_STORE),
  unresolved: fake.pathnamesIn('unresolved'),
  unparseable: fake.pathnamesIn('unparseable'),
};

process.stdout.write(`\n__SCENARIO_JSON__${JSON.stringify(out)}__END__\n`);
