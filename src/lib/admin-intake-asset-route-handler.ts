/**
 * Operator retrieval of an order's PRIVATE checkout-intake asset bytes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Split/direct checkout stages buyer media in a dedicated private Blob store
 * and binds the exact tuple onto the order. Until now no product surface could
 * hand those bytes back to an operator, so the manual Custom Story runbook told
 * §4.4 readers to escalate to engineering and forbade them from minting a token
 * or constructing a Blob URL themselves. This module is the supported,
 * authenticated, order-scoped alternative to that escalation.
 *
 * WHAT THE CALLER MAY INFLUENCE
 * -----------------------------
 * Two path segments: the order id and the opaque asset id. Nothing else. The
 * pathname read from storage is DERIVED here from the order's own bound intake
 * id and the asset id — the persisted `pathname` is verified against that
 * derivation rather than trusted, and a caller-supplied MIME, size, category,
 * intake id or URL has nowhere to enter.
 *
 * FAIL CLOSED
 * -----------
 * The asset must appear exactly once in the order's own
 * `checkoutIntake.selection`; every entry of that selection must re-validate
 * against the intake schema; the selection fingerprint must cover it; the
 * mirrored projection for its category (`primaryHeroIntakeMedia`, a family
 * character's `checkoutIntakeMedia`, `guidedStillIntakeMedia`,
 * `voiceIntakeMedia`, `documentIntakeMedia`) must agree byte for byte; and the
 * media retention must still be `active`. Anything malformed, duplicated,
 * mismatched, stale or reclaimed is a refusal — never a best-effort read.
 *
 * The provider object is verified too: exact pathname, exact bound MIME, exact
 * bound size, and a streaming read that stops the moment more bytes arrive than
 * the order says exist. An order whose stored object disagrees is an upstream
 * fault, reported as 502, not as an asset the operator may look at.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No transcription, no prose, no fulfillment, no state mutation. A GET does not
 * write to the order — the read is recorded as a metadata-only structured log
 * line (order id, opaque asset id, category, outcome) and nothing else. Both
 * ids in that line are the caller's own path segments, so they are emitted only
 * when they match a canonical grammar and replaced by a fixed sentinel when
 * they do not: an unauthenticated caller must not be able to choose what gets
 * written into the log sink.
 */
import { get } from '@vercel/blob';

import { isAdminAuthedFromRequest } from './admin-auth.ts';
import { getBlobNamespace } from './blob-namespace.ts';
import {
  INTAKE_CATEGORY_POLICY,
  finalizationFingerprint,
  getRequiredIntakeBlobToken,
  intakeAssetPath,
  parseSelectionEntry,
  type FinalizedSelectionEntry,
  type IntakeAssetCategory,
} from './checkout-intake.ts';
import { mediaClassForCategory, type MediaAssetClass } from './checkout-media-mime.ts';
import { getOrder, type OrderRecord } from './orders.ts';

/** Path-segment grammar for an asset id, matched before anything is resolved. */
const ASSET_ID_RE = /^asset_[a-f0-9]{32}$/;

/**
 * Canonical shape of an order id accepted by this private retrieval route.
 *
 * Deliberately looser than checkout's own `ord_[a-f0-9]{16}` — operational and
 * fixture ids of the same family exist — but anchored on the `ord_` prefix and
 * a bounded, punctuation-free charset. That is enough to exclude the two things
 * a caller actually puts in this path segment when it is not an order id: an
 * address (`@`, `.`, `+`) and a pasted capability (no `ord_` prefix). It is a
 * shape check, not an existence check. It runs only after authentication and
 * before the order-store boundary, so hostile path bytes reach neither storage
 * nor logs.
 */
const SAFE_ORDER_ID_RE = /^ord_[a-z0-9_]{1,48}$/;

/**
 * What a non-canonical identifier becomes in the log line.
 *
 * A fixed, non-sensitive constant rather than a truncation or a hash: both of
 * those still carry the caller's bytes into the sink, and a hash of a short
 * identifier is reversible by anyone holding the candidate list. No real id can
 * collide with it — the grammars above require an `ord_` / `asset_` prefix.
 */
const REDACTED_IDENTIFIER = '__invalid__';

/** Extension for the generated filename. Never the customer's own filename. */
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/x-caf': 'caf',
  'audio/aiff': 'aiff',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

const CATEGORY_LABEL: Readonly<Record<IntakeAssetCategory, string>> = {
  primary_hero_photo: 'Hero photo',
  family_pet_reference: 'Family / pet reference photo',
  guided_still: 'Guided still',
  voice_inspiration: 'Voice note',
  document_inspiration: 'Inspiration document',
};

/**
 * The response's own policy, which is also the policy of the document a browser
 * synthesises around it.
 *
 * Audio is served `inline`, so opening the link makes Chromium build a MEDIA
 * DOCUMENT: a generated document containing a media element whose source is
 * this same URL, fetched under the policy this response carried. `default-src
 * 'none'` therefore refuses the player its own bytes — the operator gets a
 * control strip stuck at readyState 0 and a console violation, which is not the
 * workflow §4.4 of the manual Custom Story runbook advertises.
 *
 * The allowance is exactly one directive, on exactly the responses that need
 * it: `media-src 'self'`. `'self'` resolves against the URL that delivered the
 * policy, so the sandbox's opaque origin does not have to be relaxed, and no
 * scheme, host, wildcard or `data:` source is introduced. Photos, documents and
 * every refusal keep `default-src 'none'` alone. Either way these bytes still
 * cannot act as a document: no scripts, no subresources, no forms, no framing.
 */
export function intakeAssetContentSecurityPolicy(assetClass: MediaAssetClass | null): string {
  const media = assetClass === 'audio' ? " media-src 'self';" : '';
  return `default-src 'none';${media} sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * Sent on EVERY reply, refusals included. A refusal that omitted them would be
 * the one response a shared cache is allowed to keep.
 */
function privacyHeaders(assetClass: MediaAssetClass | null): Record<string, string> {
  return {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': intakeAssetContentSecurityPolicy(assetClass),
  };
}

export interface AdminIntakeAssetReply {
  status: number;
  body: Uint8Array | { error: string } | null;
  headers: Record<string, string>;
}

/** What the storage boundary hands back. Never a URL, never a token. */
export interface IntakeAssetObject {
  pathname: string;
  contentType: string | null;
  size: number | null;
  stream: ReadableStream<Uint8Array>;
}

export type AdminIntakeAssetOutcome =
  | 'served'
  | 'unauthenticated'
  | 'order_id_invalid'
  | 'asset_id_invalid'
  | 'order_not_found'
  | 'order_unavailable'
  | 'not_bound'
  | 'binding_incoherent'
  | 'retention_inactive'
  | 'credential_unavailable'
  | 'object_unavailable'
  | 'provider_pathname_mismatch'
  | 'provider_mime_mismatch'
  | 'provider_size_mismatch';

/**
 * Metadata only: no customer PII, no pathname, no token, no URL, no bytes.
 *
 * `orderId` and `assetId` are the sanitised forms — the raw path segments if
 * they match the canonical grammars above, `REDACTED_IDENTIFIER` otherwise.
 */
export interface AdminIntakeAssetLogEvent {
  event: 'admin_intake_asset_read';
  orderId: string;
  assetId: string;
  category: IntakeAssetCategory | null;
  outcome: AdminIntakeAssetOutcome;
}

export interface AdminIntakeAssetDeps {
  isAdminAuthed?: (request: Request) => boolean;
  readOrder?: (orderId: string) => Promise<OrderRecord | null>;
  intakeToken?: () => string;
  openIntakeAsset?: (pathname: string, token: string) => Promise<IntakeAssetObject | null>;
  log?: (event: AdminIntakeAssetLogEvent) => void;
}

export interface AdminIntakeAssetLink {
  assetId: string;
  category: IntakeAssetCategory;
  label: string;
  href: string;
  mimeType: string;
  size: number;
}

export function adminIntakeAssetHref(orderId: string, assetId: string): string {
  return `/api/admin/orders/${orderId}/intake-assets/${assetId}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Re-validate the whole selection and return it, or `null`.
 *
 * Deliberately not "validate just the entry we were asked for": a selection
 * with a duplicate slot or a duplicate asset id is unaccountable evidence about
 * what this order is bound to, and the safe reading of it is that NOTHING on it
 * is retrievable.
 */
function coherentSelection(order: OrderRecord): FinalizedSelectionEntry[] | null {
  const binding = order.checkoutIntake;
  if (!binding || typeof binding !== 'object') return null;
  if (!/^intake_[a-f0-9]{32}$/.test(binding.intakeId ?? '')) return null;
  if (!Array.isArray(binding.selection) || binding.selection.length === 0) return null;

  let selection: FinalizedSelectionEntry[];
  try {
    const namespace = getBlobNamespace();
    selection = binding.selection.map((raw) =>
      parseSelectionEntry(raw, binding.intakeId, namespace));
  } catch {
    return null;
  }

  const slots = new Set<string>();
  const assets = new Set<string>();
  const familyIndexes = new Set<number>();
  for (const item of selection) {
    if (slots.has(item.slotKey) || assets.has(item.assetId)) return null;
    slots.add(item.slotKey);
    assets.add(item.assetId);
    if (item.familyCharacterIndex !== null) {
      if (familyIndexes.has(item.familyCharacterIndex)) return null;
      familyIndexes.add(item.familyCharacterIndex);
    }
  }
  if (binding.fingerprint !== finalizationFingerprint(binding.intakeId, selection)) return null;
  return selection;
}

function retentionActive(order: OrderRecord): boolean {
  return order.checkoutIntakeMediaRetention?.status === 'active';
}

/** The mirrored projection for this entry must exist and agree exactly. */
function mirrorAgrees(order: OrderRecord, item: FinalizedSelectionEntry): boolean {
  switch (item.category) {
    case 'primary_hero_photo':
      return sameJson(order.primaryHeroIntakeMedia, item);
    case 'voice_inspiration':
      return sameJson(order.voiceIntakeMedia, item);
    case 'document_inspiration':
      return sameJson(order.documentIntakeMedia, item);
    case 'guided_still': {
      const stills = Array.isArray(order.guidedStillIntakeMedia) ? order.guidedStillIntakeMedia : [];
      return stills.filter((candidate) => sameJson(candidate, item)).length === 1;
    }
    case 'family_pet_reference': {
      const characters = Array.isArray(order.familyCharacters) ? order.familyCharacters : [];
      const index = item.familyCharacterIndex;
      if (index === null || index < 0 || index >= characters.length) return false;
      // The mirror must be on the character the tuple names AND nowhere else,
      // so a duplicated projection cannot make a stale index look coherent.
      const mirrored = characters.filter((character) => sameJson(character.checkoutIntakeMedia, item));
      return mirrored.length === 1 && sameJson(characters[index]?.checkoutIntakeMedia, item);
    }
    default:
      return false;
  }
}

function generatedFilename(assetId: string, mimeType: string): string {
  const stem = `hsb-intake-${assetId}`.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${stem}.${MIME_EXTENSION[mimeType] ?? 'bin'}`;
}

/**
 * `attachment` for documents, `inline` for photos and audio.
 *
 * A PDF or .docx must never be handed to the browser as something to render;
 * a photo or a voice note is exactly what the operator opened the link to see
 * or hear, and the sandbox CSP above keeps even those inert as documents.
 */
function contentDisposition(assetClass: MediaAssetClass, filename: string): string {
  const kind = assetClass === 'document' ? 'attachment' : 'inline';
  return `${kind}; filename="${filename}"`;
}

/**
 * Buffer a stream under a hard ceiling, refusing as soon as it is exceeded.
 *
 * The limit is the SMALLER of the order's persisted expected size and the
 * category's hard cap, and it is applied per chunk, so a tampered or endless
 * object is abandoned rather than materialised in a function's memory first.
 */
async function readExactly(
  stream: ReadableStream<Uint8Array>,
  expected: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > expected) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock?.();
  }
  if (total !== expected) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function refusal(status: number, error: string): AdminIntakeAssetReply {
  // A refusal carries no bytes, so it gets no media allowance regardless of
  // which category the request was about.
  return { status, body: { error }, headers: { ...privacyHeaders(null), 'Content-Type': 'application/json' } };
}

/** Centralized policy for explicit method replies from the thin route shell. */
function methodHeaders(): Record<string, string> {
  return { ...privacyHeaders('audio'), Allow: 'GET, OPTIONS' };
}

export function adminIntakeAssetUnsupportedMethodReply(): AdminIntakeAssetReply {
  return {
    status: 405,
    body: { error: 'Method not allowed' },
    headers: { ...methodHeaders(), 'Content-Type': 'application/json' },
  };
}

export function adminIntakeAssetOptionsReply(): AdminIntakeAssetReply {
  return { status: 204, body: null, headers: methodHeaders() };
}

async function defaultOpenIntakeAsset(
  pathname: string,
  token: string,
): Promise<IntakeAssetObject | null> {
  // `useCache: false` for the same reason the intake store uses it: an edge
  // cache must not be able to answer a private-media read.
  const result = await get(pathname, { access: 'private', token, useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return {
    pathname: result.blob.pathname,
    contentType: result.blob.contentType ?? null,
    size: typeof result.blob.size === 'number' ? result.blob.size : null,
    stream: result.stream,
  };
}

export async function handleAdminIntakeAssetRequest(
  request: Request,
  orderId: string,
  assetId: string,
  deps: AdminIntakeAssetDeps = {},
): Promise<AdminIntakeAssetReply> {
  let category: IntakeAssetCategory | null = null;
  // Sanitised ONCE, up front, so no path below can reach `emit` with a raw
  // segment — including the unauthenticated refusal, which is the one an
  // arbitrary caller can reach and therefore the one that decides what an
  // arbitrary caller can write into the log sink.
  const loggedOrderId = SAFE_ORDER_ID_RE.test(orderId) ? orderId : REDACTED_IDENTIFIER;
  const loggedAssetId = ASSET_ID_RE.test(assetId) ? assetId : REDACTED_IDENTIFIER;
  const emit = (outcome: AdminIntakeAssetOutcome) => {
    const event: AdminIntakeAssetLogEvent = {
      event: 'admin_intake_asset_read',
      orderId: loggedOrderId,
      assetId: loggedAssetId,
      category,
      outcome,
    };
    if (deps.log) deps.log(event);
    else console.info(JSON.stringify(event));
  };

  if (!(deps.isAdminAuthed ?? isAdminAuthedFromRequest)(request)) {
    emit('unauthenticated');
    return refusal(401, 'Unauthorized');
  }
  if (!SAFE_ORDER_ID_RE.test(orderId)) {
    emit('order_id_invalid');
    return refusal(404, 'Not found');
  }
  if (!ASSET_ID_RE.test(assetId)) {
    emit('asset_id_invalid');
    return refusal(404, 'Not found');
  }

  // The lookup is I/O and can reject. An escaping rejection would leave this
  // function through the route shell, which sets no headers of its own: the
  // operator would get the framework's error response, without the privacy and
  // isolation headers every other reply here carries, and carrying whatever the
  // store put in the message. Fail closed through the same boundary instead —
  // 503, because a lookup that failed has not established that the order is
  // absent, and 404 would assert exactly that.
  let order: OrderRecord | null;
  try {
    const readOrder = deps.readOrder ?? ((id: string) => getOrder(id, { logFailures: false }));
    order = await readOrder(orderId);
  } catch {
    emit('order_unavailable');
    return refusal(503, 'Order unavailable');
  }
  if (!order) {
    emit('order_not_found');
    return refusal(404, 'Not found');
  }

  const selection = coherentSelection(order);
  if (!selection) {
    emit('binding_incoherent');
    return refusal(404, 'Not found');
  }
  const bound = selection.filter((item) => item.assetId === assetId);
  if (bound.length !== 1) {
    emit('not_bound');
    return refusal(404, 'Not found');
  }
  const item = bound[0]!;
  category = item.category;

  if (!retentionActive(order)) {
    emit('retention_inactive');
    return refusal(404, 'Not found');
  }
  if (!mirrorAgrees(order, item)) {
    emit('binding_incoherent');
    return refusal(404, 'Not found');
  }

  // Derived, never taken from the record. `parseSelectionEntry` has already
  // proven the persisted pathname equals this, so the two cannot diverge.
  const pathname = intakeAssetPath(order.checkoutIntake!.intakeId, item.assetId);
  const cap = INTAKE_CATEGORY_POLICY[item.category].maxBytes;
  if (!Number.isInteger(item.size) || item.size <= 0 || item.size > cap) {
    emit('binding_incoherent');
    return refusal(404, 'Not found');
  }

  let token: string;
  try {
    token = (deps.intakeToken ?? (() => getRequiredIntakeBlobToken()))();
  } catch {
    // The underlying error names the misconfigured role, never its value, and
    // it does not belong in an operator's browser either way.
    emit('credential_unavailable');
    return refusal(503, 'Intake storage unavailable');
  }

  let object: IntakeAssetObject | null;
  try {
    object = await (deps.openIntakeAsset ?? defaultOpenIntakeAsset)(pathname, token);
  } catch {
    object = null;
  }
  if (!object || !object.stream) {
    emit('object_unavailable');
    return refusal(502, 'Asset unavailable');
  }
  if (object.pathname !== pathname) {
    emit('provider_pathname_mismatch');
    return refusal(502, 'Asset unavailable');
  }
  // The stored object's own content type is checked against the order, never
  // echoed: the Content-Type below always comes from the bound tuple.
  if (object.contentType !== null && object.contentType !== item.mimeType) {
    emit('provider_mime_mismatch');
    return refusal(502, 'Asset unavailable');
  }
  if (object.size !== null && object.size !== item.size) {
    emit('provider_size_mismatch');
    return refusal(502, 'Asset unavailable');
  }

  const payload = await readExactly(object.stream, Math.min(item.size, cap));
  if (!payload) {
    emit('provider_size_mismatch');
    return refusal(502, 'Asset unavailable');
  }

  emit('served');
  const assetClass = mediaClassForCategory(item.category);
  return {
    status: 200,
    body: payload,
    headers: {
      ...privacyHeaders(assetClass),
      'Content-Type': item.mimeType,
      'Content-Length': String(payload.byteLength),
      'Content-Disposition': contentDisposition(
        assetClass,
        generatedFilename(item.assetId, item.mimeType),
      ),
    },
  };
}

/**
 * The bound assets an operator may open, for the admin order page.
 *
 * Returns role/category, the opaque asset id, and a same-origin order-scoped
 * href — and nothing else. No pathname, no URL, no capability, no etag.
 */
export function listAdminIntakeAssets(order: OrderRecord): AdminIntakeAssetLink[] {
  if (!retentionActive(order)) return [];
  const selection = coherentSelection(order);
  if (!selection) return [];
  return selection
    .filter((item) => mirrorAgrees(order, item))
    .map((item) => ({
      assetId: item.assetId,
      category: item.category,
      label: item.category === 'guided_still' && item.guidedStillIndex !== null
        ? `${CATEGORY_LABEL[item.category]} ${item.guidedStillIndex + 1}`
        : CATEGORY_LABEL[item.category],
      href: adminIntakeAssetHref(order.id, item.assetId),
      mimeType: item.mimeType,
      size: item.size,
    }));
}
