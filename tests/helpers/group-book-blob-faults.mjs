// Fault injection around the unchanged in-memory fake. Faults touch only the
// transport; every store/route decision runs from real source.
import * as base from './group-book-blob-fake.mjs';

export const journal = base.journal;
export const paths = base.paths;
export const faults = {};
// Remote commits that land after the caller already aborted (abort does not
// prove remote cancellation). Applied only when a test says so.
export const lateCommits = [];

function clearFaults() {
  Object.assign(faults, {
    readPath: null,
    readKind: null,
    commitThenThrow: false,
    afterCommitReadKind: null,
    failFamilyPutBeforeCommit: false,
    preemptFamily: null,
    failPutPrefix: null,
    delMode: null,
    beforePhotoPut: null,
    listLoop: false,
    beforeAttemptPut: null,
    hangPhotoPut: false,
  });
  lateCommits.length = 0;
}
clearFaults();

export async function reset() {
  await base.del(base.paths(), { token: 'synthetic' });
  journal.length = 0;
  clearFaults();
}

export async function get(pathname, options) {
  const result = await base.get(pathname, options);
  if (pathname === faults.readPath) {
    if (faults.readKind === '503') return { statusCode: 503, stream: null, blob: null };
    if (faults.readKind === 'parse') return { statusCode: 200, stream: new Response('{bad-json').body, blob: null };
    if (faults.readKind === 'no-stream') return { statusCode: 200, stream: null, blob: null };
    if (faults.readKind === 'throw') throw new Error('synthetic read transport outage');
  }
  return result;
}

export async function put(pathname, body, options) {
  if (faults.beforeAttemptPut && pathname.includes('/attempts/')) {
    const hook = faults.beforeAttemptPut;
    faults.beforeAttemptPut = null;
    await hook();
  }
  if (faults.hangPhotoPut && pathname.includes('/photos/')) {
    faults.hangPhotoPut = false;
    base.journal.push({ op: 'put', pathname, abortSignal: options?.abortSignal instanceof AbortSignal });
    lateCommits.push(() => base.put(pathname, body, { ...options, abortSignal: undefined }));
    // Stalled transport: only the caller's abort ends it. Without an abort the
    // safety timer fails the request so a missing bound shows up as RED.
    await new Promise((_, reject) => {
      const signal = options?.abortSignal;
      const timer = setTimeout(() => reject(new Error('no_abort_signal_bound')), 3000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('synthetic aborted');
        err.name = 'BlobRequestAbortedError';
        reject(err);
      }, { once: true });
    });
  }
  if (faults.beforePhotoPut && pathname.includes('/photos/')) {
    const hook = faults.beforePhotoPut;
    faults.beforePhotoPut = null;
    await hook();
  }
  if (faults.failPutPrefix && pathname.startsWith(faults.failPutPrefix)) {
    faults.failPutPrefix = null;
    throw new Error('synthetic put failure BEFORE commit (prefix)');
  }
  const family = pathname.includes('/families/');
  if (family && faults.preemptFamily) {
    const winner = faults.preemptFamily;
    faults.preemptFamily = null;
    await base.put(pathname, winner, options);
  }
  if (family && faults.failFamilyPutBeforeCommit) {
    faults.failFamilyPutBeforeCommit = false;
    throw new Error('synthetic put failure BEFORE commit');
  }
  const result = await base.put(pathname, body, options);
  if (family && faults.commitThenThrow) {
    faults.commitThenThrow = false;
    if (faults.afterCommitReadKind) {
      faults.readPath = pathname;
      faults.readKind = faults.afterCommitReadKind;
    }
    throw new Error('synthetic response lost AFTER committed put');
  }
  return result;
}

// delMode 'partial': delete only the first path, then throw.
// delMode 'commit-then-throw': delete all, then throw (ambiguous response).
export async function del(pathnameOrPaths, options) {
  const paths = Array.isArray(pathnameOrPaths) ? pathnameOrPaths : [pathnameOrPaths];
  const mode = faults.delMode;
  faults.delMode = null;
  if (mode === 'partial') {
    await base.del(paths.slice(0, 1), options);
    throw new Error('synthetic partial delete');
  }
  await base.del(paths, options);
  if (mode === 'commit-then-throw') throw new Error('synthetic delete response lost');
}

// listLoop: every page claims more results (unbounded pagination).
export async function list(options) {
  const page = await base.list(options);
  if (faults.listLoop) return { blobs: page.blobs, hasMore: true, cursor: `c${Math.random()}` };
  return page;
}

export async function applyLateCommits() {
  const pending = lateCommits.splice(0);
  for (const commit of pending) await commit();
  return pending.length;
}

export async function bytes(pathname) {
  const result = await base.get(pathname, { access: 'private', token: 'synthetic' });
  return result.statusCode === 200 ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
}

export async function seed(pathname, value) {
  await base.put(pathname, value, { access: 'private', token: 'synthetic', allowOverwrite: false });
}
