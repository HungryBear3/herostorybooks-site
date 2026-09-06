/**
 * `@vercel/blob`, journalled. Any call here is a durable-storage touch, which
 * a refused request must not make.
 */
import { record } from './journal.mjs';

export async function put(pathname, _body, options) {
  record('blob', 'put', { pathname, access: options?.access ?? null });
  return { pathname, url: `https://blob.test/${pathname}`, downloadUrl: `https://blob.test/${pathname}` };
}
export async function head(pathname) { record('blob', 'head', { pathname }); return null; }
export async function del(pathname) { record('blob', 'del', { pathname }); }
export async function list(options) { record('blob', 'list', { prefix: options?.prefix ?? null }); return { blobs: [], hasMore: false }; }
export async function copy(from, to) { record('blob', 'copy', { from, to }); return { pathname: to }; }
export async function get(pathname) { record('blob', 'get', { pathname }); throw new BlobNotFoundError(); }

export class BlobNotFoundError extends Error {
  constructor() { super('blob not found'); this.name = 'BlobNotFoundError'; }
}
export class BlobPreconditionFailedError extends Error {
  constructor() { super('precondition failed'); this.name = 'BlobPreconditionFailedError'; }
}
