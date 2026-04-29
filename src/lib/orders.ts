import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { get, list, put } from '@vercel/blob';

import type { FulfillmentStatus } from './fulfillment-types.ts';
export type { FulfillmentStatus };

export type OrderStatus = 'order_received' | 'preview_ready' | 'print_in_production' | 'shipped';
export type BookFormat = 'digital' | 'classic' | 'premium';
export type PaymentStatus = 'pending' | 'paid' | 'failed';

export interface ShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface OrderInput {
  childName: string;
  childAge?: string;
  theme?: string;
  lesson?: string;
  occasion?: string;
  giftMessage?: string;
  characterNotes?: string;
  appearanceOptions?: string;
  bookFormat: string;
  email: string;
  photoFileName?: string | null;
  photoBlobPath?: string | null;
  /**
   * Absolute, fetchable URL for the uploaded customer photo. Returned by
   * Vercel Blob's put() at upload time and persisted alongside photoBlobPath
   * so the FAL image-edit provider can use the photo as image_urls input
   * without needing to reconstruct a URL from HSB_PUBLIC_BLOB_BASE.
   *
   * Optional for backward compatibility with orders created before this
   * field was persisted — those still resolve via HSB_PUBLIC_BLOB_BASE.
   */
  photoBlobUrl?: string | null;
}

export type ReviewStatus =
  | 'not_started'
  | 'in_review'
  | 'customer_changes_requested'
  | 'approved';

export interface PageFeedbackEntry {
  createdAt: string;
  rawText: string;
  tags: string[];
  providerTried?: 'openai' | 'fal' | 'fal_edit' | null;
  resultImageUrl?: string | null;
  success: boolean;
}

export interface PageVersionEntry {
  createdAt: string;
  imageUrl: string | null;
  provider: 'openai' | 'fal' | 'fal_edit';
  model: string;
  promptUsed: string;
  /** Whether this version came from a text-only or photo-conditioned call.
   *  Optional for backward compatibility with versions written before the
   *  conditioning lane existed. */
  conditioning?: 'text_only' | 'photo_edit' | null;
  /** When conditioning='photo_edit', the customer photo URL passed to the
   *  provider. */
  referencePhotoUrl?: string | null;
}

export type ReviewAuditEventType =
  | 'proof_generated'
  | 'proof_rebuilt'
  | 'proof_review_acknowledged'
  | 'page_regenerated'
  | 'page_accepted'
  | 'whole_book_approved'
  | 'whole_book_approval_rejected';

export interface ReviewAuditEvent {
  /** ISO timestamp the event was recorded. */
  at: string;
  type: ReviewAuditEventType;
  /** 0-indexed page (when applicable). */
  pageIndex?: number | null;
  /** Short stable reason code (e.g. 'pages_not_accepted', 'proof_ack_missing'). */
  reason?: string | null;
  /** Free-form, sanitized metadata. Keep small. */
  meta?: Record<string, string | number | boolean | null> | null;
}

export interface PageArtifact {
  pageIndex: number;
  storyText: string;
  basePrompt: string;
  /** Frozen story-level character description used as the first section of
   *  every page prompt (initial AND regenerate). This is the single anchor
   *  that keeps the same child visually consistent across all pages of one
   *  story. Set once at fulfillment time from StoryContent.characterDescription
   *  and never edited. Optional for backward compatibility with older orders. */
  characterAnchor?: string | null;
  currentImageUrl: string | null;
  acceptedImageUrl?: string | null;
  generationProvider?: 'openai' | 'fal' | 'fal_edit' | null;
  generationModel?: string | null;
  /** Whether the CURRENT image on this page used text-only or photo-conditioned
   *  generation. Refreshed every regenerate. Null when no image yet. */
  generationConditioning?: 'text_only' | 'photo_edit' | null;
  regenerateCount: number;
  accepted: boolean;
  feedbackHistory: PageFeedbackEntry[];
  versionHistory: PageVersionEntry[];
}

export interface OrderRecord extends OrderInput {
  id: string;
  bookFormat: BookFormat;
  formatLabel: string;
  priceCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  stripeSessionId?: string | null;
  shippingAddress?: ShippingAddress | null;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string | null;
  storyArtifactUrl?: string | null;
  /** How the story for this order was produced (template / openai_chat /
   *  template_after_openai_failure). Set once during fulfillment, never
   *  overwritten. Optional for backward compatibility with older orders. */
  storyMeta?: import('./fulfillment-types.ts').StoryMeta | null;
  printInteriorArtifactUrl?: string | null;
  printInteriorMd5?: string | null;
  printInteriorPageCount?: number | null;
  printCoverArtifactUrl?: string | null;
  printCoverMd5?: string | null;
  printTitle?: string | null;
  proofApprovalToken?: string | null;
  proofApprovedAt?: string | null;
  /** ISO timestamp the customer ticked the "I reviewed the full proof PDF"
   *  acknowledgment on /review. Required server-side before approveWholeBook. */
  proofReviewedAt?: string | null;
  printJobId?: string | null;
  printJobStatus?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedAt?: string | null;
  deliveryExpectation: string;
  /** Per-page review state. Optional for backward compatibility with old orders. */
  reviewStatus?: ReviewStatus;
  pageArtifacts?: PageArtifact[];
  /** Append-only audit log of review/approval events. Optional on legacy orders. */
  auditEvents?: ReviewAuditEvent[];
  createdAt: string;
  updatedAt: string;
}

export function isPrintFormat(bookFormat: string): boolean {
  return bookFormat === 'classic' || bookFormat === 'premium';
}

interface CreateOrderOptions {
  now?: string;
  id?: string;
}

const FORMAT_META: Record<BookFormat, { label: string; priceCents: number }> = {
  digital: { label: 'Digital', priceCents: 1499 },
  classic: { label: 'Classic', priceCents: 3999 },
  premium: { label: 'Premium', priceCents: 5999 },
};

/**
 * Vercel Blob access mode for order JSON + photo writes/reads.
 *
 * Defaults to `'public'` because that's how the production store is provisioned
 * (the prod token rejects `private` writes with `BlobError: Cannot use private
 * access on a public store`). Override with `HSB_BLOB_ACCESS_MODE=private`
 * once a private store is provisioned.
 *
 * Privacy note: when access is `public`, the blob URLs are unguessable
 * (orderId is a 16-char random hex; photo path is `orders/<id>/photo-...`)
 * but not authenticated. Treat URLs as bearer credentials — log them only
 * where appropriate. Do not embed them in public surfaces.
 */
export type BlobAccessMode = 'public' | 'private';
export function getBlobAccessMode(): BlobAccessMode {
  const env = process.env.HSB_BLOB_ACCESS_MODE;
  if (env === 'private') return 'private';
  if (env === 'public') return 'public';
  return 'public';
}

export async function readBlobText(input: {
  pathname: string;
  url?: string | null;
  token: string;
}): Promise<string | null> {
  const access = getBlobAccessMode();

  if (access === 'public') {
    const url = input.url;
    if (!url) return null;
    const response = await fetch(url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Public blob fetch failed: ${response.status} ${response.statusText}`.trim());
    }
    return await response.text();
  }

  const result = await get(input.pathname, {
    access,
    token: input.token,
    useCache: false,
  });

  if (!result || !result.stream) {
    return null;
  }

  return await new Response(result.stream).text();
}

function normalizeFormat(bookFormat: string): BookFormat {
  if (bookFormat === 'digital' || bookFormat === 'classic' || bookFormat === 'premium') {
    return bookFormat;
  }

  return 'classic';
}

export function buildDeliveryExpectation(bookFormat: string): string {
  const format = normalizeFormat(bookFormat);

  if (format === 'digital') {
    return 'PDF by email in ~15 minutes';
  }

  if (format === 'premium') {
    return 'Hardcover ships in 5–7 business days — free shipping included. Digital preview arrives first so you can approve before it prints.';
  }

  return 'Softcover ships in 5–7 business days — free shipping included. Digital preview arrives first so you can approve before it prints.';
}

export function createOrderRecord(input: OrderInput, options: CreateOrderOptions = {}): OrderRecord {
  const format = normalizeFormat(input.bookFormat);
  const meta = FORMAT_META[format];
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    childName: input.childName.trim(),
    childAge: input.childAge?.trim() || '',
    theme: input.theme?.trim() || '',
    lesson: input.lesson?.trim() || '',
    occasion: input.occasion?.trim() || '',
    giftMessage: input.giftMessage?.trim() || '',
    characterNotes: input.characterNotes?.trim() || '',
    appearanceOptions: input.appearanceOptions?.trim() || '',
    bookFormat: format,
    formatLabel: meta.label,
    priceCents: meta.priceCents,
    email: input.email.trim().toLowerCase(),
    photoFileName: input.photoFileName?.trim() || null,
    photoBlobPath: input.photoBlobPath?.trim() || null,
    photoBlobUrl: input.photoBlobUrl?.trim() || null,
    status: 'order_received',
    paymentStatus: 'pending',
    stripeSessionId: null,
    shippingAddress: null,
    deliveryExpectation: buildDeliveryExpectation(format),
    createdAt: now,
    updatedAt: now,
  };
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

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

export function getBlobNamespace(): string {
  const explicit = (process.env.HSB_BLOB_NAMESPACE ?? '').trim();
  // Vercel automatically sets VERCEL_ENV to one of 'production' | 'preview' |
  // 'development' on every deployment.
  const vercelEnv = process.env.VERCEL_ENV;

  if (vercelEnv === 'preview') {
    if (!explicit) {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE must be set on Vercel Preview deployments " +
          "to prevent reading/writing the production order namespace. " +
          "Set HSB_BLOB_NAMESPACE='preview' (or any non-empty value other " +
          "than 'production') on the Preview environment.",
      );
    }
    if (explicit === 'production') {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE='production' is forbidden on Vercel Preview — " +
          "it would target the production namespace. Use 'preview' instead.",
      );
    }
    return explicit;
  }

  if (vercelEnv === 'development') {
    return explicit || 'development';
  }

  // Production deployments OR non-Vercel runs (CI, local node, scripts):
  // respect an explicit namespace if provided, otherwise use flat paths.
  // Flat is required so that already-stored production blobs at `orders/...`
  // remain readable without a one-time migration.
  return explicit;
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
export function withBlobNamespace(path: string): string {
  const ns = getBlobNamespace();
  if (!ns) return path;
  // Strip any leading slashes from the input to keep the join clean.
  const cleaned = path.replace(/^\/+/, '');
  return `${ns}/${cleaned}`;
}

/**
 * Custom error thrown when an order cannot be durably persisted in a
 * production-like environment. Callers (notably /api/order) MUST treat this
 * as fatal and abort BEFORE creating a Stripe Checkout Session — otherwise
 * the customer pays for an order the system cannot find later.
 */
export class OrderPersistenceError extends Error {
  readonly orderId: string;
  readonly cause?: unknown;
  constructor(orderId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'OrderPersistenceError';
    this.orderId = orderId;
    this.cause = cause;
  }
}

/**
 * Production-like = any environment where ephemeral tmpfs is unsafe for order
 * persistence: Vercel (always), explicit production NODE_ENV, or an explicit
 * opt-in via HSB_REQUIRE_DURABLE_PERSISTENCE.
 *
 * Tests can opt out by setting HSB_REQUIRE_DURABLE_PERSISTENCE=false.
 */
export function requiresDurablePersistence(): boolean {
  if (process.env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'true') return true;
  if (process.env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'false') return false;
  if (process.env.VERCEL) return true;
  if (process.env.NODE_ENV === 'production') return true;
  return false;
}

function getOrderStoreDir() {
  // Explicit override always wins (used by tests and the recovery script).
  if (process.env.HSB_ORDER_STORE_DIR) return process.env.HSB_ORDER_STORE_DIR;
  // Vercel still needs a writable scratch dir for the tiny number of legitimate
  // local-only call sites (e.g., the recovery script running during a one-off
  // job). Live persistence MUST go through blob — see persistOrder().
  // Static paths only. Dynamic FS roots (os.tmpdir(), process.cwd()) made
  // Turbopack's NFT pull the whole project into every function bundle and
  // exceed Vercel's deploy upload limit. On Vercel/Linux os.tmpdir() is always
  // '/tmp'; for local dev a relative path resolves against CWD at call time.
  if (process.env.VERCEL) return '/tmp/hsb/orders';
  return '.data/orders';
}

function getOrderBlobPath(orderId: string) {
  return withBlobNamespace(`orders/${orderId}.json`);
}

/**
 * Prefix used by listOrders/getOrder for blob list calls. Honors namespace
 * isolation, so a Preview deployment listing "orders/" actually lists
 * "preview/orders/" — guaranteeing Preview cannot see Production records.
 */
function getOrdersListPrefix() {
  return withBlobNamespace('orders/');
}

/**
 * Resolve the customer photo URL the FAL image-edit provider should fetch.
 *
 * Resolution order (first match wins):
 *   1. order.photoBlobUrl — the absolute URL Vercel Blob returned at upload
 *      time. Set on every order created after this field landed; durable.
 *   2. order.photoBlobPath if it is already an absolute URL (recovery flows
 *      sometimes store a full URL there).
 *   3. Reconstruct from process.env.HSB_PUBLIC_BLOB_BASE + photoBlobPath
 *      (legacy path for orders persisted before photoBlobUrl was added).
 *   4. Otherwise null — the orchestrator will fall through to text-only FAL.
 *
 * Returning null is by design: it signals "we cannot photo-condition this
 * order safely" rather than fabricating a URL the FAL provider would 404 on.
 */
export function getOrderPhotoUrl(
  order: Pick<OrderRecord, 'photoBlobPath' | 'photoBlobUrl'>,
): string | null {
  // 1. Persisted absolute URL — the durable, env-independent path.
  const persistedUrl = order.photoBlobUrl?.trim();
  if (persistedUrl) return persistedUrl;

  const blobPath = order.photoBlobPath?.trim();
  if (!blobPath) return null;

  // 2. photoBlobPath itself is absolute (recovery flows).
  if (/^https?:\/\//i.test(blobPath)) return blobPath;

  // 3. Legacy reconstruction via env override.
  const explicit = process.env.HSB_PUBLIC_BLOB_BASE?.replace(/\/$/, '');
  if (explicit) return `${explicit}/${blobPath}`;

  // 4. No way to resolve — caller falls back to text-only.
  return null;
}

/**
 * Result of uploadOrderPhoto. The `url` is the absolute, fetchable Vercel
 * Blob URL — persist it on OrderRecord.photoBlobUrl so downstream code
 * (FAL image-edit) does not need HSB_PUBLIC_BLOB_BASE to reconstruct it.
 */
export interface UploadedPhotoRef {
  pathname: string;
  url: string;
}

export async function uploadOrderPhoto(orderId: string, file: File): Promise<UploadedPhotoRef | null> {
  const token = getBlobToken();

  if (typeof file.arrayBuffer !== 'function') {
    return null;
  }

  if (!token) {
    // In production-like envs, missing the blob token for an actual customer
    // photo upload is a hard failure — we'd otherwise drop the photo silently.
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderPhoto: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}). Refusing to drop customer photo silently.`,
      );
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot durably store customer photo',
      );
    }
    // Local dev with no blob token: explicit, expected behavior.
    return null;
  }

  const safeName = (file.name || 'photo')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'photo';

  const pathname = withBlobNamespace(`orders/${orderId}/photo-${safeName}`);
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const blob = await put(pathname, buffer, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: file.type || 'application/octet-stream',
      token,
    });
    return { pathname: blob.pathname, url: blob.url };
  } catch (err) {
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderPhoto: blob put failed in production-like env (orderId=${orderId}, pathname=${pathname}):`,
        err,
      );
      throw new OrderPersistenceError(
        orderId,
        'Customer photo upload to durable storage failed',
        err,
      );
    }
    // Local dev: surface the error without crashing checkout — caller decides.
    console.warn(`[orders] uploadOrderPhoto blob put failed in dev for ${orderId}:`, err);
    return null;
  }
}

export async function persistOrder(order: OrderRecord) {
  const token = getBlobToken();
  const serialized = JSON.stringify(order, null, 2);
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      await put(getOrderBlobPath(order.id), serialized, {
        access: getBlobAccessMode(),
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
      });
      return order;
    } catch (err) {
      // In production-like envs we MUST NOT silently fall back to ephemeral
      // tmp filesystem — that's how a customer pays Stripe and the webhook
      // later cannot find the order. Fail loudly. Caller (the order route)
      // is responsible for aborting BEFORE Stripe Checkout Session creation.
      if (requireDurable) {
        console.error(
          `[orders] persistOrder: blob put failed in production-like env (orderId=${order.id}). ` +
            `Refusing silent tmp fallback. Cause:`,
          err,
        );
        throw new OrderPersistenceError(
          order.id,
          'Durable order persistence failed (blob put error)',
          err,
        );
      }
      // Local dev: fall through to filesystem fallback below.
      console.warn(`[orders] persistOrder blob put failed in dev for ${order.id}:`, err);
    }
  } else if (requireDurable) {
    // Production-like env with no blob token configured at all — hard fail.
    console.error(
      `[orders] persistOrder: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${order.id}). Refusing silent tmp fallback.`,
    );
    throw new OrderPersistenceError(
      order.id,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot durably persist order',
    );
  }

  // Local-dev / explicit override path only.
  const dir = getOrderStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${order.id}.json`, `${serialized}\n`, 'utf8');
  return order;
}

export async function getOrder(orderId: string) {
  const token = getBlobToken();
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      if (getBlobAccessMode() === 'public') {
        const { blobs } = await list({ prefix: getOrderBlobPath(orderId), token });
        const blob = blobs.find((b) => b.pathname === getOrderBlobPath(orderId));
        if (!blob?.url) return null;
        const text = await readBlobText({ pathname: blob.pathname, url: blob.url, token });
        return text ? (JSON.parse(text) as OrderRecord) : null;
      }

      const text = await readBlobText({ pathname: getOrderBlobPath(orderId), token });
      return text ? (JSON.parse(text) as OrderRecord) : null;
    } catch (err) {
      if (requireDurable) {
        // In production, blob errors must NOT silently fall back to ephemeral
        // disk — that's how the webhook reads from a different store than
        // persistOrder() wrote to. Re-throw so the caller can log + 500.
        console.error(
          `[orders] getOrder: blob read failed in production-like env (orderId=${orderId}):`,
          err,
        );
        throw err;
      }
      console.warn(`[orders] getOrder blob read failed in dev for ${orderId}:`, err);
      // dev: fall through to filesystem
    }
  } else if (requireDurable) {
    console.error(
      `[orders] getOrder: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}).`,
    );
    throw new OrderPersistenceError(
      orderId,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot read order',
    );
  }

  try {
    const file = await readFile(`${getOrderStoreDir()}/${orderId}.json`, 'utf8');
    return JSON.parse(file) as OrderRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function listOrders(): Promise<OrderRecord[]> {
  const token = getBlobToken();

  if (token) {
    try {
      const { blobs } = await list({ prefix: getOrdersListPrefix(), token });
      const orders: OrderRecord[] = [];
      for (const blob of blobs) {
        if (!blob.pathname.endsWith('.json')) continue;
        try {
          const text = await readBlobText({ pathname: blob.pathname, url: blob.url, token });
          if (!text) continue;
          orders.push(JSON.parse(text) as OrderRecord);
        } catch {
          // skip corrupt/unreadable blobs
        }
      }
      return orders;
    } catch {
      // fall through to filesystem fallback
    }
  }

  const dir = getOrderStoreDir();
  try {
    const files = await readdir(dir);
    const orders: OrderRecord[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const text = await readFile(`${dir}/${file}`, 'utf8');
        orders.push(JSON.parse(text) as OrderRecord);
      } catch {
        // skip corrupt files
      }
    }
    return orders;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function isOrderStatus(value: string): value is OrderStatus {
  return ['order_received', 'preview_ready', 'print_in_production', 'shipped'].includes(value);
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  const existing = await getOrder(orderId);
  if (!existing) {
    return null;
  }

  const updated: OrderRecord = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}

type FulfillmentPatch = Partial<Pick<
  OrderRecord,
  | 'fulfillmentStatus'
  | 'fulfillmentAttempts'
  | 'fulfillmentLastError'
  | 'storyArtifactUrl'
  | 'storyMeta'
  | 'printInteriorArtifactUrl'
  | 'printInteriorMd5'
  | 'printInteriorPageCount'
  | 'printCoverArtifactUrl'
  | 'printCoverMd5'
  | 'printTitle'
  | 'proofApprovalToken'
  | 'proofApprovedAt'
  | 'proofReviewedAt'
  | 'printJobId'
  | 'printJobStatus'
  | 'trackingNumber'
  | 'trackingUrl'
  | 'shippedAt'
  | 'status'
  | 'reviewStatus'
  | 'pageArtifacts'
  | 'auditEvents'
>>;

export async function updateFulfillmentState(
  orderId: string,
  patch: FulfillmentPatch,
): Promise<OrderRecord | null> {
  const existing = await getOrder(orderId);
  if (!existing) return null;

  const updated: OrderRecord = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}

/**
 * Append-only audit log helper. Every review/approval event flows through here
 * so the trail is in one place. Read-modify-write on the order record — same
 * pattern as updateFulfillmentState. Returns the updated order, or null if the
 * order does not exist (caller decides whether that's an error).
 */
export async function appendAuditEvent(
  orderId: string,
  event: Omit<ReviewAuditEvent, 'at'> & { at?: string },
): Promise<OrderRecord | null> {
  const existing = await getOrder(orderId);
  if (!existing) return null;
  const entry: ReviewAuditEvent = {
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    ...(event.pageIndex != null ? { pageIndex: event.pageIndex } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
  const updated: OrderRecord = {
    ...existing,
    auditEvents: [...(existing.auditEvents ?? []), entry],
    updatedAt: new Date().toISOString(),
  };
  await persistOrder(updated);
  return updated;
}

export async function updateOrderPayment(
  orderId: string,
  paymentStatus: PaymentStatus,
  opts: { stripeSessionId?: string; shippingAddress?: ShippingAddress } = {},
) {
  const existing = await getOrder(orderId);
  if (!existing) return null;

  const updated: OrderRecord = {
    ...existing,
    paymentStatus,
    ...(opts.stripeSessionId != null ? { stripeSessionId: opts.stripeSessionId } : {}),
    ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}
