export const journal = [];
const objects = new Map();

function record(op, pathname, options = {}) {
  journal.push({
    op,
    pathname,
    access: options.access ?? null,
    explicitToken: typeof options.token === 'string',
    allowOverwrite: options.allowOverwrite ?? null,
  });
}

export async function put(pathname, body, options = {}) {
  record('put', pathname, options);
  if (options.access !== 'private' || typeof options.token !== 'string') {
    throw new Error('private explicit token required');
  }
  if (options.allowOverwrite === false && objects.has(pathname)) {
    throw new Error('blob already exists');
  }
  objects.set(pathname, {
    body: typeof body === 'string' ? body : Buffer.from(body),
    contentType: options.contentType ?? 'application/octet-stream',
  });
  return { pathname };
}

export async function get(pathname, options = {}) {
  record('get', pathname, options);
  if (options.access !== 'private' || typeof options.token !== 'string') {
    throw new Error('private explicit token required');
  }
  const entry = objects.get(pathname);
  if (!entry) return { statusCode: 404, stream: null, blob: null };
  const bytes = typeof entry.body === 'string' ? Buffer.from(entry.body) : entry.body;
  return {
    statusCode: 200,
    stream: new Response(bytes).body,
    blob: { size: bytes.byteLength, contentType: entry.contentType },
  };
}

export async function del(pathnameOrPaths, options = {}) {
  const paths = Array.isArray(pathnameOrPaths) ? pathnameOrPaths : [pathnameOrPaths];
  for (const pathname of paths) {
    record('del', pathname, options);
    if (typeof options.token !== 'string') throw new Error('explicit token required');
    objects.delete(pathname);
  }
}

export function paths() {
  return [...objects.keys()].sort();
}
