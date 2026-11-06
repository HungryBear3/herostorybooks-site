import { createHash } from 'node:crypto';

import { isAdminAuthedFromRequest } from '../admin-auth.ts';
import {
  createOrderRecord,
  OrderPersistenceError,
  persistNewOrder,
  readOrderVersioned,
  type BookFormat,
  type GroupBookAssemblyBinding,
  type OrderRecord,
} from '../orders.ts';
import {
  assertClassroomAssemblyCurrent,
  publishClassroomManifest,
  readClassroomManifest,
  type ManifestPublication,
} from './assembly.ts';
import { assembleGroupBookExport } from './export.ts';

/**
 * Authenticated classroom order creation: complete roster -> existing
 * admission snapshot/recheck -> private manifest -> current-assembly rechecks
 * -> one create-only unpaid pending/manual_hold order.
 *
 * Every order input is TRUSTED and injected; the request body is never read.
 * Without a trusted input source (the default runtime) the handler answers 503
 * after authentication. No payment, provider, email or release occurs.
 */
export interface ClassroomTrustedInput {
  cohortId: string;
  bookFormat: BookFormat;
  contactEmail: string;
}

export interface ClassroomOrderDeps {
  authenticate?: (request: Request) => boolean;
  trustedInput?: (() => Promise<ClassroomTrustedInput | null>) | null;
  now?: () => Date;
  /** Test seam for controlled interleavings; a no-op in production. */
  barrier?: (point: string) => Promise<void>;
}

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: HEADERS });
const FORMATS: ReadonlySet<string> = new Set(['digital', 'classic', 'premium']);

/** Stable order identity: cohort + admitted snapshot digest, never the format. */
export function classroomOrderId(cohortId: string, digest: string): string {
  return `ord_${createHash('sha256').update(JSON.stringify(['hsb-classroom-order-v1', cohortId, digest])).digest('hex').slice(0, 16)}`;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

/** Replay is accepted only for an unchanged pending/manual_hold record. */
function unchangedReplay(existing: OrderRecord, fresh: OrderRecord): boolean {
  if (existing.paymentStatus !== 'pending' || existing.fulfillmentMode !== 'manual_hold' || existing.status !== 'order_received') return false;
  const { createdAt: _a, updatedAt: _b, ...left } = existing;
  const { createdAt: _c, updatedAt: _d, ...right } = fresh;
  void _a; void _b; void _c; void _d;
  return stable(left) === stable(right);
}

function trusted(value: unknown): value is ClassroomTrustedInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return typeof input.cohortId === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(input.cohortId)
    && typeof input.bookFormat === 'string' && FORMATS.has(input.bookFormat)
    && typeof input.contactEmail === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(input.contactEmail);
}

export async function classroomOrderResponse(request: Request, deps: ClassroomOrderDeps = {}): Promise<Response> {
  const authenticate = deps.authenticate ?? isAdminAuthedFromRequest;
  if (!authenticate(request)) return reply(401, { error: 'Unauthorized' });
  if (!deps.trustedInput) return reply(503, { error: 'classroom_trusted_input_unavailable' });
  let input: ClassroomTrustedInput | null;
  try {
    input = await deps.trustedInput();
  } catch {
    input = null;
  }
  if (!trusted(input)) return reply(503, { error: 'classroom_trusted_input_unavailable' });
  const now = deps.now ?? (() => new Date());
  const barrier = deps.barrier ?? (async () => {});
  const start = now();
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) {
    return reply(409, { error: 'manifest_refused', reason: 'invalid_clock' });
  }

  try {
    let publication: ManifestPublication | null = null;
    let lookupFailed = false;
    const outcome = await assembleGroupBookExport({
      cohortId: input.cohortId,
      afterSnapshot: () => barrier('order:after_snapshot'),
      publisher: async (snapshot) => {
        // An existing order for this exact snapshot is replayed against ITS
        // manifest; a missing or expired one is refused, never reconstructed.
        let existing: Awaited<ReturnType<typeof readOrderVersioned>>;
        try {
          existing = await readOrderVersioned(classroomOrderId(snapshot.cohortId, snapshot.digest));
        } catch {
          lookupFailed = true;
          return { published: true as const };
        }
        if (existing) {
          const read = await readClassroomManifest(existing.order.groupBookAssembly, { now });
          publication = read.state === 'found' ? { state: 'replayed', manifest: read.manifest } : { state: 'refused', reason: read.reason };
        } else {
          publication = await publishClassroomManifest(snapshot, { now, barrier });
        }
        return { published: true as const };
      },
    });
    if (lookupFailed) return reply(500, { error: 'classroom_order_failed' });
    if (outcome.state === 'refused' && outcome.reason === 'participation_changed') return reply(409, { error: 'participation_changed' });
    if (outcome.state !== 'published') return reply(409, { error: 'roster_not_ready' });
    const published = publication as ManifestPublication | null;
    if (!published) return reply(409, { error: 'roster_not_ready' });
    if (published.state === 'refused') return reply(409, { error: 'manifest_refused', reason: published.reason });
    const manifest = published.manifest;
    const binding: GroupBookAssemblyBinding = {
      schemaVersion: 1,
      cohortId: manifest.cohortId,
      digest: manifest.digest,
      participantCount: manifest.participantCount,
      expiresAt: manifest.expiresAt,
    };

    // Rechecks after publication and immediately before persistence. Blob has
    // no multi-object transaction; this narrows but cannot close the window.
    const recheck = async (): Promise<Response | null> => {
      const check = await assertClassroomAssemblyCurrent(binding, { now });
      if (check.ok === false) {
        if (check.reason === 'participation_changed' || check.reason === 'roster_not_ready') return reply(409, { error: check.reason });
        return reply(409, { error: 'manifest_refused', reason: check.reason });
      }
      return null;
    };
    await barrier('order:after_manifest');
    const afterManifest = await recheck();
    if (afterManifest) return afterManifest;
    await barrier('order:before_final_recheck');
    await barrier('order:before_persist');
    // Final assertion immediately adjacent to persistence.
    const final = await recheck();
    if (final) return final;

    const id = classroomOrderId(binding.cohortId, binding.digest);
    const fresh: OrderRecord = {
      ...createOrderRecord(
        { childName: 'Classroom book', bookFormat: input.bookFormat, email: input.contactEmail },
        { id, now: now().toISOString(), fulfillmentMode: 'manual_hold' },
      ),
      groupBookAssembly: binding,
    };
    try {
      await persistNewOrder(fresh);
      return reply(201, { state: 'created', orderId: id });
    } catch (error) {
      if (!(error instanceof OrderPersistenceError) || error.message !== 'Refusing to overwrite an existing order during creation') throw error;
    }
    const existing = await readOrderVersioned(id);
    if (existing && unchangedReplay(existing.order, fresh)) return reply(200, { state: 'replayed', orderId: id });
    return reply(409, { error: 'classroom_order_conflict' });
  } catch {
    return reply(500, { error: 'classroom_order_failed' });
  }
}
