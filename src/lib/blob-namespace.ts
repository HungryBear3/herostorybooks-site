/**
 * Blob namespace isolation — shared by the order store, the checkout intake
 * store and the checkout abuse guard.
 *
 * Extracted from `orders.ts` (which still re-exports it) so that subsystems
 * which must not depend on the order module use the SAME rule rather than a
 * second copy of it. A second copy is how one keyspace ends up namespaced and
 * another does not.
 *
 * `env` is a parameter rather than a direct `process.env` read so a caller
 * that has already resolved its environment — and a test — can be explicit.
 * Every existing caller passes nothing and gets the previous behaviour.
 */

// ── Blob namespace isolation ─────────────────────────────────────────────────
//
// Without a namespace, every environment that shares BLOB_READ_WRITE_TOKEN
// (Production / Preview / Development) writes to the same flat `orders/...`
// keyspace and can read/mutate each other's records. To prevent Preview from
// touching real customer order data, we prepend an environment-derived prefix
// to every blob path used by this app.
//
// Required configuration:
//   - Production: HSB_BLOB_NAMESPACE unset (or empty) → flat paths (legacy
//     compatibility with already-stored orders).
//   - Preview:    HSB_BLOB_NAMESPACE must be set to a non-empty, non-"production"
//                 value (recommended: "preview"). Failing to set it on a Vercel
//                 Preview deployment is a hard error — we fail closed rather
//                 than silently target the production namespace.
//   - Development: HSB_BLOB_NAMESPACE optional; defaults to "development".
//
// Recommended belt+suspenders in Vercel:
//   1. Provision a separate Vercel Blob store for Preview/Development with its
//      own BLOB_READ_WRITE_TOKEN, and scope that token only to Preview +
//      Development.
//   2. ALSO set HSB_BLOB_NAMESPACE=preview on Preview (and "development" on
//      Development). The two together mean a token leak alone can't expose
//      production data, and a namespace misconfiguration alone can't either.
export class BlobNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobNamespaceError';
  }
}

const BLOB_NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validateExplicitNamespace(value: string): string {
  // A namespace is one storage path segment, not an arbitrary path. Keeping
  // the grammar narrow prevents dot-segment and separator normalization from
  // collapsing Preview keys onto the flat production keyspace.
  if (!BLOB_NAMESPACE_RE.test(value)) {
    throw new BlobNamespaceError(
      'HSB_BLOB_NAMESPACE must be one canonical non-production path segment (1-64 letters, digits, _ or -).',
    );
  }
  return value;
}

export function getBlobNamespace(env: NodeJS.ProcessEnv = process.env): string {
  const rawExplicit = env.HSB_BLOB_NAMESPACE ?? '';
  const explicit = rawExplicit.trim();
  // Do not silently repair whitespace: configured bytes must be canonical.
  if (rawExplicit && rawExplicit !== explicit) validateExplicitNamespace(rawExplicit);
  const canonical = explicit ? validateExplicitNamespace(explicit) : '';
  // Vercel automatically sets VERCEL_ENV to one of 'production' | 'preview' |
  // 'development' on every deployment.
  const vercelEnv = env.VERCEL_ENV;

  if (vercelEnv === 'preview') {
    if (!explicit) {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE must be set on Vercel Preview deployments " +
          "to prevent reading/writing the production order namespace. " +
          "Set HSB_BLOB_NAMESPACE='preview' (or any non-empty value other " +
          "than 'production') on the Preview environment.",
      );
    }
    if (canonical.toLowerCase() === 'production') {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE='production' is forbidden on Vercel Preview.",
      );
    }
    return canonical;
  }

  if (vercelEnv === 'development') {
    return canonical || 'development';
  }

  // Production deployments OR non-Vercel runs (CI, local node, scripts):
  // respect an explicit namespace if provided, otherwise use flat paths.
  // Flat is required so that already-stored production blobs at `orders/...`
  // remain readable without a one-time migration.
  return canonical;
}

/**
 * Apply the configured namespace prefix to a blob path.
 *
 * Examples (with HSB_BLOB_NAMESPACE='preview'):
 *   withBlobNamespace('orders/abc.json') → 'preview/orders/abc.json'
 *   withBlobNamespace('orders/')         → 'preview/orders/'
 *
 * With no namespace (production default):
 *   withBlobNamespace('orders/abc.json') → 'orders/abc.json'  (unchanged)
 */
export function withBlobNamespace(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return applyBlobNamespace(path, getBlobNamespace(env));
}

/**
 * Join a path onto an ALREADY-RESOLVED namespace.
 *
 * Callers that resolve their namespace once (at store construction, say) use
 * this so there is exactly one implementation of the join rule. An empty
 * namespace means flat paths — the production default.
 */
export function applyBlobNamespace(path: string, namespace: string): string {
  if (!namespace) return path;
  // Strip any leading slashes from the input to keep the join clean.
  const cleaned = path.replace(/^\/+/, '');
  return `${namespace.replace(/\/+$/, '')}/${cleaned}`;
}
