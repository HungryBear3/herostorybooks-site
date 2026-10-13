// Fault injection around the unchanged in-memory fake. Faults touch only the
// transport; every store/route decision runs from real source.
import * as base from './group-book-blob-fake.mjs';

export const journal = base.journal;
export const paths = base.paths;
export const faults = {};

function clearFaults() {
  Object.assign(faults, {
    readPath: null,
    readKind: null,
    commitThenThrow: false,
    afterCommitReadKind: null,
    failFamilyPutBeforeCommit: false,
    preemptFamily: null,
  });
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

export const del = base.del;

export async function bytes(pathname) {
  const result = await base.get(pathname, { access: 'private', token: 'synthetic' });
  return result.statusCode === 200 ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
}

export async function seed(pathname, value) {
  await base.put(pathname, value, { access: 'private', token: 'synthetic', allowOverwrite: false });
}
