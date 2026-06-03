import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { list, put } from '@vercel/blob';

import {
  requiresDurablePersistence,
  withBlobNamespace,
} from './orders.ts';

export const KILL_SWITCH_REFUSAL_PREFIX = 'KILL_SWITCH_ACTIVE';

export type KillSwitchId =
  | 'checkout_pause'
  | 'proof_release_hold'
  | 'owner_print_go_hold'
  | 'marketing_hold'
  | 'provider_hold'
  | 'print_provider_hold';

export type KillSwitchMode = 'enforced' | 'manual';

export interface KillSwitchDefinition {
  id: KillSwitchId;
  label: string;
  mode: KillSwitchMode;
  summary: string;
  enforcement: string;
}

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface KillSwitchEvent extends KillSwitchState {
  id: KillSwitchId;
}

export interface KillSwitchSnapshotItem extends KillSwitchDefinition, KillSwitchState {}

export interface KillSwitchSnapshot {
  switches: KillSwitchSnapshotItem[];
  history: KillSwitchEvent[];
  generatedAt: string;
}

export interface UpdateKillSwitchInput {
  id: KillSwitchId;
  active: boolean;
  reason?: string | null;
  updatedBy: string;
  now?: string;
}

interface KillSwitchStore {
  states: Partial<Record<KillSwitchId, KillSwitchState>>;
  history: KillSwitchEvent[];
}

/**
 * Thrown when kill-switch state cannot be durably read or written in a
 * production-like environment. Callers (admin route + every
 * `isKillSwitchActive` enforcement seam) MUST surface this as a hard
 * failure — falling back silently to local FS would yield
 * per-Vercel-function-instance state divergence and a kill-switch
 * console that does not actually halt anything.
 *
 * The admin API maps this to HTTP 503 with code `DURABILITY_FAILED` so
 * the UI can render a specific "console non-functional / unsafe"
 * warning rather than a generic transient 500.
 */
export class KillSwitchDurabilityError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'KillSwitchDurabilityError';
    this.cause = cause;
  }
}

export const KILL_SWITCH_DEFINITIONS: KillSwitchDefinition[] = [
  {
    id: 'checkout_pause',
    label: 'KS-1 Checkout pause',
    mode: 'enforced',
    summary: 'Refuses new checkout requests before form parsing, uploads, or Stripe session creation.',
    enforcement: '/api/order returns 503 before customer data is processed.',
  },
  {
    id: 'proof_release_hold',
    label: 'KS-2 Proof release hold',
    mode: 'enforced',
    summary: 'Blocks every admin path that sends a customer email (QA pass, resend proof, resend digital, retry).',
    enforcement: 'releaseOrderAfterQa / resendProofEmail / resendDigitalDelivery / retryOrderFulfillment refuse before any email transport.',
  },
  {
    id: 'owner_print_go_hold',
    label: 'KS-3 Owner print-go hold',
    mode: 'enforced',
    summary: 'Blocks owner print-go before the durable print intent lock is acquired.',
    enforcement: 'recordOwnerPrintGo / submitPrintAfterOwnerGo refuse before lock or provider side effect.',
  },
  {
    id: 'marketing_hold',
    label: 'KS-4 Marketing hold',
    mode: 'manual',
    summary: 'Manual traffic/creator/gifting/social stop flag for operator visibility.',
    enforcement: 'Status-only: no automated marketing integrations are wired in this app.',
  },
  {
    id: 'provider_hold',
    label: 'KS-5 Provider hold',
    mode: 'manual',
    summary: 'Manual generation/provider stop flag for operator visibility.',
    enforcement: 'Status-only: generation routing has policy guards but no single provider toggle here.',
  },
  {
    id: 'print_provider_hold',
    label: 'KS-6 Print-provider hold',
    mode: 'enforced',
    summary: 'Blocks Lulu/RPI print submission after owner print-go but before provider call.',
    enforcement: 'runPrintProduction refuses before submitting_to_print and before submitPrintJob.',
  },
];

const IDS = new Set<KillSwitchId>(KILL_SWITCH_DEFINITIONS.map((item) => item.id));

export function isKillSwitchId(value: unknown): value is KillSwitchId {
  return typeof value === 'string' && IDS.has(value as KillSwitchId);
}

/**
 * Blob path for the single shared KS state JSON. One object per
 * deployment namespace; read-modify-write semantics with
 * `allowOverwrite: true`. KS toggles are operator-triggered and
 * audited (the JSON carries a history array), so last-write-wins is
 * acceptable; no concurrent admin POSTs are expected in practice.
 */
function getKillSwitchBlobPath(): string {
  return withBlobNamespace('ops/state/hsb-kill-switches.json');
}

/**
 * Filesystem fallback path. Used ONLY when
 * `requiresDurablePersistence()` returns false (i.e., dev/test).
 * Production code paths never reach this branch — durable failure
 * throws `KillSwitchDurabilityError` instead.
 *
 * The default is a STATIC RELATIVE path (no `process.cwd()`). Node
 * resolves it against the CWD at runtime, but Turbopack's NFT can
 * analyze it statically — `process.cwd()` would otherwise scope the
 * function trace to the whole project root and balloon the bundle.
 * Tests inject HSB_KILL_SWITCH_STATE_PATH to point at a tmpdir.
 */
export function killSwitchStatePath(): string {
  return process.env.HSB_KILL_SWITCH_STATE_PATH
    || path.join('ops', 'state', 'hsb-kill-switches.json');
}

function emptyState(): KillSwitchState {
  return { active: false, reason: null, updatedBy: null, updatedAt: null };
}

function normalizeStore(parsed: unknown): KillSwitchStore {
  const obj = (parsed && typeof parsed === 'object') ? (parsed as Partial<KillSwitchStore>) : {};
  const states = (obj.states && typeof obj.states === 'object') ? obj.states : {};
  const history = Array.isArray(obj.history)
    ? obj.history.filter((event) => event && isKillSwitchId(event.id))
    : [];
  return { states, history };
}

function getBlobToken(): string | undefined {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

async function readStoreFromBlob(): Promise<KillSwitchStore> {
  const token = getBlobToken();
  if (!token) {
    throw new KillSwitchDurabilityError(
      'BLOB_READ_WRITE_TOKEN missing in production — cannot read kill-switch state. KS console is unsafe to use; switches that depend on durable state will not propagate across function instances.',
    );
  }
  try {
    const pathname = getKillSwitchBlobPath();
    const { blobs } = await list({ prefix: pathname, token, limit: 10 });
    const match = blobs.find((blob) => blob.pathname === pathname);
    if (!match?.url) {
      return { states: {}, history: [] };
    }
    const separator = match.url.includes('?') ? '&' : '?';
    const response = await fetch(`${match.url}${separator}ts=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) {
      return { states: {}, history: [] };
    }
    if (!response.ok) {
      throw new Error(`public blob fetch ${response.status} ${response.statusText}`.trim());
    }
    const raw = await response.text();
    if (!raw.trim()) return { states: {}, history: [] };
    const parsed = JSON.parse(raw);
    return normalizeStore(parsed);
  } catch (err) {
    const anyErr = err as { status?: number; message?: string };
    const status = anyErr?.status;
    const msg = String(anyErr?.message ?? '');
    // 404 / not-found on first-ever read is fine — we treat it as an
    // empty store. Any other failure is a real durability problem.
    if (status === 404 || /not found/i.test(msg)) {
      return { states: {}, history: [] };
    }
    throw new KillSwitchDurabilityError(
      `Failed to read kill-switch state from blob: ${msg || 'unknown error'}`,
      err,
    );
  }
}

async function writeStoreToBlob(store: KillSwitchStore): Promise<void> {
  const token = getBlobToken();
  if (!token) {
    throw new KillSwitchDurabilityError(
      'BLOB_READ_WRITE_TOKEN missing in production — cannot write kill-switch state. Refusing to silently fall back to local FS (would leave per-instance divergent state).',
    );
  }
  const body = `${JSON.stringify(store, null, 2)}\n`;
  try {
    await put(getKillSwitchBlobPath(), body, {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/json',
      token,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new KillSwitchDurabilityError(
      `Failed to write kill-switch state to blob: ${msg}`,
      err,
    );
  }
}

async function readStoreFromFs(): Promise<KillSwitchStore> {
  try {
    // turbopackIgnore tells NFT not to walk from this fs call's
    // dynamic argument into the project tree — the resolved path is
    // env-var-controlled at runtime and Turbopack's static analyzer
    // can't see through that.
    const raw = await readFile(/* turbopackIgnore: true */ killSwitchStatePath(), 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { states: {}, history: [] };
    }
    throw error;
  }
}

async function writeStoreToFs(store: KillSwitchStore): Promise<void> {
  const file = killSwitchStatePath();
  await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  await writeFile(/* turbopackIgnore: true */ file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

async function readStore(): Promise<KillSwitchStore> {
  if (requiresDurablePersistence()) {
    return await readStoreFromBlob();
  }
  // Dev/test FS fallback. The NODE_ENV check below is redundant with
  // requiresDurablePersistence() at runtime (it also returns true
  // when NODE_ENV==='production'), but Turbopack's NFT can constant-
  // fold `process.env.NODE_ENV !== 'production'` in a production
  // build and statically eliminate the readStoreFromFs() branch.
  // Without this fold, NFT sees an `fs.readFile` reachable from the
  // /api/order route bundle and balloons the function trace into
  // every file at the project root — exactly the "unexpected file
  // in NFT list" warning Vercel surfaces.
  if (process.env.NODE_ENV !== 'production') {
    return await readStoreFromFs();
  }
  throw new KillSwitchDurabilityError(
    'KS state requires durable persistence in production; FS fallback is dev/test only',
  );
}

async function writeStore(store: KillSwitchStore): Promise<void> {
  if (requiresDurablePersistence()) {
    return await writeStoreToBlob(store);
  }
  if (process.env.NODE_ENV !== 'production') {
    return await writeStoreToFs(store);
  }
  throw new KillSwitchDurabilityError(
    'KS state requires durable persistence in production; FS fallback is dev/test only',
  );
}

export async function getKillSwitchSnapshot(): Promise<KillSwitchSnapshot> {
  const store = await readStore();
  const switches = KILL_SWITCH_DEFINITIONS.map((definition) => ({
    ...definition,
    ...(store.states[definition.id] ?? emptyState()),
  }));
  return {
    switches,
    history: store.history.slice(-50).reverse(),
    generatedAt: new Date().toISOString(),
  };
}

export async function updateKillSwitch(input: UpdateKillSwitchInput): Promise<KillSwitchSnapshotItem> {
  if (!isKillSwitchId(input.id)) {
    throw new Error('UNKNOWN_KILL_SWITCH');
  }
  const updatedBy = input.updatedBy.trim().slice(0, 120);
  if (!updatedBy) {
    throw new Error('UPDATED_BY_REQUIRED');
  }
  const reason = (input.reason ?? '').trim().slice(0, 500);
  if (input.active && !reason) {
    throw new Error('REASON_REQUIRED_WHEN_ACTIVE');
  }

  const now = input.now ?? new Date().toISOString();
  const nextState: KillSwitchState = {
    active: input.active,
    reason: reason || null,
    updatedBy,
    updatedAt: now,
  };
  const store = await readStore();
  store.states[input.id] = nextState;
  store.history = [
    ...(store.history ?? []),
    { id: input.id, ...nextState },
  ].slice(-200);
  await writeStore(store);

  const definition = KILL_SWITCH_DEFINITIONS.find((item) => item.id === input.id);
  if (!definition) throw new Error('UNKNOWN_KILL_SWITCH');
  return { ...definition, ...nextState };
}

/**
 * Read-time check used at every enforcement seam. Surfaces the
 * durable-read failure to the caller via
 * `KillSwitchDurabilityError`. Enforcement seams MUST decide how to
 * respond (the recommended policy is fail-closed — treat unknown
 * durability state as "switch active" — but the per-seam wiring
 * decides because the safe interpretation differs between, e.g.,
 * proof_release_hold and provider_hold).
 *
 * The existing seams in admin-actions.ts / fulfillment.ts wrap this
 * call in try/catch and treat any thrown error as
 * KILL_SWITCH_STATE_UNAVAILABLE — a refusal — so a durability outage
 * cannot silently let a customer email or print submit through.
 */
export async function isKillSwitchActive(id: KillSwitchId): Promise<boolean> {
  const store = await readStore();
  return store.states[id]?.active === true;
}

/**
 * Fail-closed wrapper around `isKillSwitchActive`. Returns a tagged
 * result so every enforcement seam can distinguish three states:
 *
 *   - `{ active: false }`              — switch is off, proceed
 *   - `{ active: true }`               — switch is on, refuse
 *   - `{ unavailable: true; reason }`  — durable store is unreachable;
 *                                        fail closed (treat as refuse),
 *                                        seam decides which error code
 *                                        to surface
 *
 * Production callers MUST treat `unavailable` as a refusal: silently
 * proceeding would defeat the entire kill-switch design. The reason
 * string is bounded so it can land in operator-visible error copy
 * without leaking storage internals.
 */
export type KillSwitchEnforceResult =
  | { kind: 'inactive' }
  | { kind: 'active' }
  | { kind: 'unavailable'; reason: string };

export async function enforceKillSwitch(id: KillSwitchId): Promise<KillSwitchEnforceResult> {
  try {
    const active = await isKillSwitchActive(id);
    return active ? { kind: 'active' } : { kind: 'inactive' };
  } catch (err) {
    if (err instanceof KillSwitchDurabilityError) {
      const reason = err.message.slice(0, 240);
      console.error(`[ops-kill-switches] durability failure on '${id}': ${reason}`);
      return { kind: 'unavailable', reason };
    }
    throw err;
  }
}

export const KILL_SWITCH_STATE_UNAVAILABLE_CODE = 'KILL_SWITCH_STATE_UNAVAILABLE';

export function killSwitchUnavailableMessage(label: string, reason: string): string {
  return `${KILL_SWITCH_STATE_UNAVAILABLE_CODE}: ${label} state could not be read durably (${reason}). Refusing the request fail-closed.`;
}

export function killSwitchRefusal(id: KillSwitchId, label: string): string {
  void id;
  return `${KILL_SWITCH_REFUSAL_PREFIX}: ${label} is active`;
}
