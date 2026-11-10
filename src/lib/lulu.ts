import { normalizeShippingContact, shippingService, shippingFailure, type ShippingContact } from './shipping-selection.ts';
import { readOrderInitialShipping, sha256, type InitialShippingProviderQualificationV1 } from './initial-shipping-contract.ts';
import { submitAuthorizedExpedited, type ExpeditedDispatchAuthorization } from './initial-shipping-dispatch.ts';
import type { OrderRecord } from './orders.ts';
import {
  luluCostCalculationToQuote,
  type LuluCostCalculationResponse,
  type PrintCostQuoteProvider,
  type PrintCostQuoteRequest,
  type PrintCostQuoteResult,
  type PrintUpgradeShippingAddress,
} from './print-upgrade-quote.ts';

export interface PrintArtifactBundle {
  interiorUrl: string;
  interiorMd5: string;
  interiorPageCount: number;
  coverUrl: string;
  coverMd5: string;
  title: string;
}

export interface LuluJobResult {
  jobId: string;
  status: 'submitted' | 'pending';
  estimatedShipDate?: string;
}

export interface LuluDeps {
  fetch?: typeof globalThis.fetch;
}

export interface LuluCoverDimensions {
  widthPt: number;
  heightPt: number;
}

// ── Config ─────────────────────────────────────────────────────────────────────

function getBaseUrl() {
  return (process.env.LULU_API_URL ?? 'https://api.lulu.com').replace(/\/$/, '');
}

function getAuthBaseUrl() {
  const base = new URL(getBaseUrl());
  return base.origin;
}

const TOKEN_PATH = '/auth/realms/glasstree/protocol/openid-connect/token';
// Lulu's Browser Integrity Check can reject generic Node/Python User-Agents with 1010.
// Identify this integration on every API request, including cost calculations.
const LULU_USER_AGENT = 'HeroStoryBooks/1.0 (Lulu Print API integration)';

export function podPackageIdForFormat(bookFormat: string): string {
  return podPackageId(bookFormat);
}

function podPackageId(bookFormat: string): string {
  if (bookFormat === 'premium') {
    return process.env.LULU_HARDCOVER_POD_PACKAGE_ID ?? '0850X0850.FC.STD.CW.080CW444.MXX';
  }
  return process.env.LULU_SOFTCOVER_POD_PACKAGE_ID ?? '0850X0850.FC.STD.PB.080CW444.GXX';
}

function getPrintArtifacts(order: OrderRecord): PrintArtifactBundle {
  const title = order.printTitle?.trim() || `${order.childName}'s Hero Story Book`;
  const interiorUrl = order.printInteriorArtifactUrl ?? '';
  const interiorMd5 = order.printInteriorMd5 ?? '';
  const interiorPageCount = order.printInteriorPageCount ?? 0;
  const coverUrl = order.printCoverArtifactUrl ?? '';
  const coverMd5 = order.printCoverMd5 ?? '';

  if (!interiorUrl || !interiorMd5 || !interiorPageCount || !coverUrl || !coverMd5) {
    throw new Error('Lulu print-ready interior/cover artifacts are required before submitting a print job.');
  }

  return {
    interiorUrl,
    interiorMd5,
    interiorPageCount,
    coverUrl,
    coverMd5,
    title,
  };
}

// ── Token cache (in-process) ───────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let _cache: CachedToken | null = null;

export function clearTokenCache(): void {
  _cache = null;
}

async function fetchAccessToken(
  clientKey: string,
  clientSecret: string,
  _fetch: typeof globalThis.fetch,
): Promise<string> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now + 30_000) {
    return _cache.accessToken;
  }

  const credentials = Buffer.from(`${clientKey}:${clientSecret}`).toString('base64');
  const res = await _fetch(`${getAuthBaseUrl()}${TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': LULU_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lulu auth failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  _cache = { accessToken: data.access_token, expiresAt: now + data.expires_in * 1_000 };
  return _cache.accessToken;
}

export async function calculateCoverDimensions(
  order: OrderRecord,
  interiorPageCount: number,
  deps: LuluDeps = {},
): Promise<LuluCoverDimensions> {
  const clientKey = process.env.LULU_CLIENT_KEY;
  const clientSecret = process.env.LULU_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    throw new Error('LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required — configure the Lulu integration first.');
  }

  const _fetch = deps.fetch ?? globalThis.fetch;
  const accessToken = await fetchAccessToken(clientKey, clientSecret, _fetch);
  const res = await _fetch(`${getBaseUrl()}/cover-dimensions/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': LULU_USER_AGENT,
    },
    body: JSON.stringify({
      pod_package_id: podPackageId(order.bookFormat),
      interior_page_count: interiorPageCount,
      unit: 'pt',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lulu cover dimensions error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { width?: number | string; height?: number | string };
  const widthPt = Number(data.width);
  const heightPt = Number(data.height);
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) {
    throw new Error('Lulu cover dimensions response missing width/height in points.');
  }

  return { widthPt, heightPt };
}

// ── Print job submission ───────────────────────────────────────────────────────

/** Print-only operation-local auth. Does not alter legacy token cache or quote transport.
 * Capture endpoint/account/fetch before awaiting, resolve token before canonical fencing.
 */
export async function prepareExpeditedPrintTransport(provider: InitialShippingProviderQualificationV1): Promise<(body: Record<string, unknown>) => Promise<LuluJobResult>> {
  const base = getBaseUrl(); const key = process.env.LULU_CLIENT_KEY; const secret = process.env.LULU_CLIENT_SECRET;
  const fetch = globalThis.fetch;
  if (!key || !secret || !['https://api.lulu.com', 'https://api.sandbox.lulu.com'].includes(base) ||
    base !== provider.endpointOrigin || sha256(key) !== provider.accountBinding) throw new Error('shipping_dispatch_account_drift');
  let accessToken: string;
  try {
    const result = await fetch(base + TOKEN_PATH, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': LULU_USER_AGENT }, body: 'grant_type=client_credentials' });
    const raw = await shippingJson(result) as Record<string, unknown>;
    if (typeof raw.access_token !== 'string' || !/^[A-Za-z0-9._~-]{1,16384}$/.test(raw.access_token) ||
      !Number.isSafeInteger(raw.expires_in) || (raw.expires_in as number) < 1) throw new Error();
    accessToken = raw.access_token;
  } catch { throw new Error('shipping_dispatch_auth_unavailable'); }
  return async body => {
    // No auth await between canonical attempt fence and irreversible POST.
    try {
      const result = await fetch(base + '/print-jobs/', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': LULU_USER_AGENT },
        body: JSON.stringify(body) });
      const raw = await shippingJson(result) as Record<string, unknown>;
      if ((typeof raw.id !== 'string' && typeof raw.id !== 'number') || !/^[A-Za-z0-9_-]{1,100}$/.test(String(raw.id))) throw new Error();
      return { jobId: String(raw.id), status: 'submitted' };
    } catch { throw new Error('shipping_print_submission_requires_reconciliation'); }
  };
}


export async function submitPrintJob(
  order: OrderRecord,
  deps: LuluDeps & { authorization?: ExpeditedDispatchAuthorization } = {},
): Promise<LuluJobResult> {
  if (readOrderInitialShipping(order).kind !== 'absent') return submitAuthorizedExpedited(order, deps.authorization);
  const clientKey = process.env.LULU_CLIENT_KEY;
  const clientSecret = process.env.LULU_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    throw new Error(
      'LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required — configure the Lulu integration first.',
    );
  }

  const artifacts = getPrintArtifacts(order);
  const _fetch = deps.fetch ?? globalThis.fetch;
  const accessToken = await fetchAccessToken(clientKey, clientSecret, _fetch);

  const body: Record<string, unknown> = {
    external_id: order.id,
    contact_email: process.env.HSB_SUPPORT_EMAIL || process.env.EMAIL_FROM || order.email,
    shipping_level: process.env.LULU_SHIPPING_LEVEL ?? 'MAIL',
    line_items: [
      {
        title: artifacts.title,
        external_id: order.id,
        pod_package_id: podPackageId(order.bookFormat),
        quantity: 1,
        interior: {
          source_url: artifacts.interiorUrl,
          source_md5_sum: artifacts.interiorMd5,
        },
        cover: {
          source_url: artifacts.coverUrl,
          source_md5_sum: artifacts.coverMd5,
        },
      },
    ],
  };

  if (order.shippingAddress) {
    body.shipping_address = {
      name: order.childName,
      street1: order.shippingAddress.line1,
      ...(order.shippingAddress.line2 ? { street2: order.shippingAddress.line2 } : {}),
      city: order.shippingAddress.city,
      state_code: order.shippingAddress.state,
      postcode: order.shippingAddress.zip,
      country_code: order.shippingAddress.country,
      phone_number: process.env.LULU_FALLBACK_PHONE ?? '000-000-0000',
    };
  }

  const res = await _fetch(`${getBaseUrl()}/print-jobs/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': LULU_USER_AGENT,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Lulu API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as {
    id?: number | string;
    status?: string;
    estimated_shipping_dates?: { earliest?: string };
  };

  if (data.id == null || String(data.id).trim() === '') {
    throw new Error('Lulu API success response missing print job id; outcome requires reconciliation');
  }
  const jobId = String(data.id);

  return {
    jobId,
    status: 'submitted',
    ...(data.estimated_shipping_dates?.earliest
      ? { estimatedShipDate: data.estimated_shipping_dates.earliest }
      : {}),
  };
}

// ── Print-job cost calculation (no print job is created) ──────────────────────

export interface LuluCostCalculationInput {
  podPackageId: string;
  pageCount: number;
  quantity?: number;
  shippingAddress: PrintUpgradeShippingAddress & { phone?: string; isBusiness?: boolean; isPostbox?: boolean };
  shippingLevel: string;
  requireActualContact?: true;
}

function costRequestBody(input: LuluCostCalculationInput, phone: string, business?: boolean) {
  const address = input.shippingAddress;
  return {
    line_items: [{ pod_package_id: input.podPackageId, page_count: input.pageCount, quantity: input.quantity ?? 1 }],
    shipping_address: {
      name: address.name, street1: address.line1, ...(address.line2 ? { street2: address.line2 } : {}),
      city: address.city, state_code: address.state, postcode: address.zip, country_code: address.country,
      phone_number: phone, ...(business === undefined ? {} : { is_business: business }),
    },
    shipping_option: input.shippingLevel,
  };
}

export interface LuluShippingRequest {
  readonly podPackageId: string; readonly pageCount: number; readonly quantity: 1;
  readonly currency: 'USD'; readonly address: ShippingContact;
}
function shippingRequest(input: LuluShippingRequest): LuluShippingRequest {
  const address = normalizeShippingContact(input.address);
  if (typeof input.podPackageId !== 'string' || !input.podPackageId.trim() || input.podPackageId.length > 100 ||
    !Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.quantity !== 1 || input.currency !== 'USD') {
    throw shippingFailure('SHIPPING_INPUT_INVALID');
  }
  return Object.freeze({ address, podPackageId: input.podPackageId.trim(), pageCount: input.pageCount, quantity: 1, currency: 'USD' });
}

/** Bounded value-free JSON reader for the new shipping lane only. */
async function shippingJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 256 * 1024) { await reader.cancel().catch(() => {}); throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE'); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { reader.releaseLock(); }
}

/** Real shipping discovery/cost transport. New operation-local auth never shares legacy _cache.
 * Endpoint, credentials and fetch are captured before any await. Only injected fetch is used in tests.
 */
export function createLuluShippingTransport(deps: LuluDeps = {}) {
  let base: string;
  try {
    const url = new URL(getBaseUrl());
    if (url.protocol !== 'https:' || !['api.lulu.com', 'api.sandbox.lulu.com'].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error();
    base = url.origin;
  } catch { throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE'); }
  const clientKey = process.env.LULU_CLIENT_KEY; const clientSecret = process.env.LULU_CLIENT_SECRET;
  const fetch = deps.fetch ?? globalThis.fetch;
  let cached: { token: string; until: number } | null = null;
  async function token(): Promise<string> {
    if (!clientKey || !clientSecret) throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE');
    if (cached && cached.until > Date.now() + 30000) return cached.token;
    const res = await fetch(base + TOKEN_PATH, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${clientKey}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': LULU_USER_AGENT }, body: 'grant_type=client_credentials' });
    const raw = await shippingJson(res) as Record<string, unknown>;
    if (!raw || typeof raw.access_token !== 'string' || !/^[A-Za-z0-9._~-]{1,16384}$/.test(raw.access_token) ||
      !Number.isSafeInteger(raw.expires_in) || (raw.expires_in as number) < 1 || (raw.expires_in as number) > 86400) {
      throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE');
    }
    cached = { token: raw.access_token, until: Date.now() + (raw.expires_in as number) * 1000 };
    return cached.token;
  }
  async function post(path: string, body: unknown, authenticated: boolean): Promise<unknown> {
    try {
      const auth = authenticated ? await token() : null;
      return await shippingJson(await fetch(base + path, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': LULU_USER_AGENT,
          ...(auth === null ? {} : { Authorization: `Bearer ${auth}` }) }, body: JSON.stringify(body) }));
    } catch { throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE'); }
  }
  return Object.freeze({
    /** Separate auth await so a caller can recheck its clock before any cost request is sent. */
    async authorize(): Promise<void> {
      try { await token(); } catch { throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE'); }
    },
    async discover(value: LuluShippingRequest): Promise<unknown> {
      const r = shippingRequest(value); const a = r.address;
      return post('/shipping-options/', { currency: r.currency,
        line_items: [{ pod_package_id: r.podPackageId, page_count: r.pageCount, quantity: r.quantity }],
        shipping_address: { name: a.name, phone_number: a.phone, street1: a.line1, ...(a.line2 ? { street2: a.line2 } : {}),
          city: a.city, country: a.country, state: a.state, postcode: a.zip, is_business: a.isBusiness, is_postbox: a.isPostbox } }, false);
    },
    async cost(value: LuluShippingRequest, service: string): Promise<LuluCostCalculationResponse> {
      const r = shippingRequest(value); const level = shippingService(service);
      const body = costRequestBody({ podPackageId: r.podPackageId, pageCount: r.pageCount, quantity: r.quantity,
        shippingAddress: r.address, shippingLevel: level }, r.address.phone, r.address.isBusiness);
      return await post('/print-job-cost-calculations/', body, true) as LuluCostCalculationResponse;
    },
  });
}

/**
 * POST /print-job-cost-calculations/ — "calculate product and shipping cost
 * without creating a Print-Job". The documented request requires street1,
 * city, country_code, postcode and phone_number; the phone falls back to the
 * same LULU_FALLBACK_PHONE the print-job submission uses.
 */
export async function calculatePrintJobCost(
  input: LuluCostCalculationInput,
  deps: LuluDeps = {},
): Promise<LuluCostCalculationResponse> {
  if (input.requireActualContact === true) {
    const address = normalizeShippingContact(input.shippingAddress);
    const request = shippingRequest({ address, podPackageId: input.podPackageId, pageCount: input.pageCount,
      quantity: (input.quantity ?? 1) as 1, currency: 'USD' });
    const service = shippingService(input.shippingLevel);
    return createLuluShippingTransport(deps).cost(request, service);
  }
  const clientKey = process.env.LULU_CLIENT_KEY;
  const clientSecret = process.env.LULU_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error('LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required — configure the Lulu integration first.');
  }
  if (!Number.isInteger(input.pageCount) || input.pageCount <= 0) {
    throw new Error('Lulu cost calculation requires a positive integer page count');
  }
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new Error('Lulu cost calculation requires a quantity from 1 to 10');
  }
  const _fetch = deps.fetch ?? globalThis.fetch;
  const accessToken = await fetchAccessToken(clientKey, clientSecret, _fetch);
  const body = costRequestBody({ ...input, quantity }, process.env.LULU_FALLBACK_PHONE ?? '000-000-0000');
  const res = await _fetch(`${getBaseUrl()}/print-job-cost-calculations/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': LULU_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Lulu cost calculation error ${res.status}: ${text.slice(0, 200)}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('Lulu cost calculation returned a non-JSON body');
  }
  if (!data || typeof data !== 'object') throw new Error('Lulu cost calculation returned an empty body');
  return data as LuluCostCalculationResponse;
}

/** Provider adapter for the customer at-cost print upgrade quote. */
export function createLuluPrintCostQuoteProvider(deps: LuluDeps = {}): PrintCostQuoteProvider {
  return {
    async quote(request: PrintCostQuoteRequest): Promise<PrintCostQuoteResult> {
      const shippingLevel = process.env.LULU_SHIPPING_LEVEL ?? 'MAIL';
      const pod = podPackageId(request.targetFormat);
      const response = await calculatePrintJobCost({
        podPackageId: pod,
        pageCount: request.pageCount,
        quantity: request.quantity ?? 1,
        shippingAddress: request.shippingAddress,
        shippingLevel,
      }, deps);
      const quote = luluCostCalculationToQuote(response, { podPackageId: pod, shippingLevel, quantity: request.quantity ?? 1 });
      // The cost API has no reliable delivery date. Only publish a window when
      // operations has verified a current production+transit range for this SKU.
      const minDays = Number(process.env.HSB_PRINT_DELIVERY_MIN_DAYS);
      const maxDays = Number(process.env.HSB_PRINT_DELIVERY_MAX_DAYS);
      if (!Number.isInteger(minDays) || !Number.isInteger(maxDays) || minDays < 1 || maxDays < minDays || maxDays > 90) {
        return quote;
      }
      const now = new Date();
      const dateAfter = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);
      return { ...quote, estimatedDeliveryStart: dateAfter(minDays), estimatedDeliveryEnd: dateAfter(maxDays) };
    },
  };
}
