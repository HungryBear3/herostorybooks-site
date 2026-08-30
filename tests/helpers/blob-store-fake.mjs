/**
 * A two-store fake of `@vercel/blob`, for proving that the Family
 * Review lane and the order lane talk to DIFFERENT stores.
 *
 * The real SDK resolves a store from the token it is handed, falling
 * back to the ambient `BLOB_READ_WRITE_TOKEN` when no `token:` option is
 * given. That resolution rule IS the thing under test — the whole
 * private-Blob boundary is the claim that Family Review passes an
 * explicit token and every other lane does not — so this fake models it
 * exactly and records, per call, which store the call landed on and
 * whether it carried a token.
 *
 * The fake is substituted for the real package by
 * tests/helpers/blob-fake-register.mjs, which installs a module-resolve
 * hook. Nothing under src/ knows it exists.
 *
 * A token VALUE is never journalled. Only the parsed store id and a
 * boolean. A test that had to compare token strings to prove isolation
 * would be one leaked assertion message away from printing a
 * credential.
 */

/** Every call, in order. The scenario runner serializes this. */
export const journal = [];

/** storeId -> Map<pathname, {body, contentType, access}> */
const stores = new Map();

function storeFor(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  return stores.get(id);
}

/** Same parse the runtime and the migration use. */
function storeIdFromToken(token) {
  if (typeof token !== 'string') return null;
  const m = token.trim().match(/^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/);
  return m ? m[1] : null;
}

/**
 * The SDK's store resolution: an explicit token wins, otherwise the
 * ambient one. `unresolved` stands for "no credential at all", which the
 * real SDK would reject.
 */
function resolveStore(options) {
  const explicit = options && typeof options.token === 'string' ? options.token : undefined;
  const raw = explicit ?? process.env.BLOB_READ_WRITE_TOKEN;
  const id = storeIdFromToken(raw) ?? (raw ? 'unparseable' : 'unresolved');
  return { id, hasToken: explicit !== undefined };
}

function record(op, pathname, options, extra = {}) {
  const { id, hasToken } = resolveStore(options);
  journal.push({
    op,
    pathname: pathname ?? null,
    storeId: id,
    hasExplicitToken: hasToken,
    access: (options && options.access) || null,
    ...extra,
  });
  return id;
}

export class BlobNotFoundError extends Error {
  constructor(message = 'blob not found') {
    super(message);
    this.name = 'BlobNotFoundError';
  }
}

export class BlobError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlobError';
  }
}

export class BlobPreconditionFailedError extends Error {
  constructor(message = 'precondition failed') {
    super(message);
    this.name = 'BlobPreconditionFailedError';
  }
}

/**
 * A public store rejects a private write, and vice versa — the
 * constraint that forced the cutover to be a cross-store copy rather
 * than an access flip. Store ids beginning `pub` are modelled as public
 * stores here so a test can assert the failure rather than assume it.
 */
function accessConflict(storeId, access) {
  if (access === 'private' && storeId.startsWith('pub')) {
    return new BlobError('Cannot use private access on a public store');
  }
  return null;
}

export async function put(pathname, body, options = {}) {
  const storeId = record('put', pathname, options, { bytes: body?.byteLength ?? body?.length ?? null });
  const conflict = accessConflict(storeId, options.access);
  if (conflict) throw conflict;
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  storeFor(storeId).set(pathname, {
    body: text,
    contentType: options.contentType ?? 'application/octet-stream',
    access: options.access ?? 'public',
  });
  return options.access === 'private'
    ? { pathname }
    : { pathname, url: `http://127.0.0.1:1/${storeId}/${pathname}` };
}

export async function get(pathname, options = {}) {
  const storeId = record('get', pathname, options, { useCache: options.useCache ?? null });
  const entry = storeFor(storeId).get(pathname);
  if (!entry) return { statusCode: 404, stream: null, blob: null };
  return {
    statusCode: 200,
    stream: new Response(entry.body).body,
    blob: { size: Buffer.byteLength(entry.body), contentType: entry.contentType },
  };
}

export async function head(pathname, options = {}) {
  const storeId = record('head', pathname, options);
  const entry = storeFor(storeId).get(pathname);
  if (!entry) throw new BlobNotFoundError();
  return { size: Buffer.byteLength(entry.body), contentType: entry.contentType, pathname };
}

export async function del(pathname, options = {}) {
  const storeId = record('del', pathname, options);
  storeFor(storeId).delete(pathname);
}

export async function list(options = {}) {
  const storeId = record('list', options.prefix ?? null, options);
  const blobs = [];
  for (const [pathname, entry] of storeFor(storeId)) {
    if (options.prefix && !pathname.startsWith(options.prefix)) continue;
    blobs.push({
      pathname,
      url: `http://127.0.0.1:1/${storeId}/${pathname}`,
      uploadedAt: new Date(0),
      size: Buffer.byteLength(entry.body),
    });
  }
  return { blobs, hasMore: false, cursor: undefined };
}

/** Test-only: seed an object into a named store without journalling. */
export function seed(storeId, pathname, body, contentType = 'application/json', access = 'public') {
  storeFor(storeId).set(pathname, { body, contentType, access });
}

/** Test-only: what a store holds, for cross-contamination assertions. */
export function pathnamesIn(storeId) {
  return [...storeFor(storeId).keys()].sort();
}

export function resetJournal() {
  journal.length = 0;
}
