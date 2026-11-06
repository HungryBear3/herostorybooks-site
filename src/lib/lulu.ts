import type { OrderRecord } from './orders.ts';
import type { ResolvedPrintContact } from './print-contact-store.ts';
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

export interface LuluPrintDeps extends LuluDeps {
  /** Bound private contact. A real print job has no fallback. */
  contact?: ResolvedPrintContact;
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
// Lulu job ids are integers. Anything else is an unknown reply, not an id to store.
const LULU_PRINT_JOB_ID = /^[0-9]{1,20}$/;
const LULU_SHIP_DATE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]+)?$/;

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

export async function submitPrintJob(
  order: OrderRecord,
  deps: LuluPrintDeps = {},
): Promise<LuluJobResult> {
  const clientKey = process.env.LULU_CLIENT_KEY;
  const clientSecret = process.env.LULU_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    throw new Error(
      'LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required — configure the Lulu integration first.',
    );
  }

  const contact = deps.contact;
  if (!contact || contact.orderId !== order.id || !contact.recipientName || !contact.phone) {
    throw new Error('print_contact_required');
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

  body.shipping_address = {
    name: contact.recipientName,
    street1: contact.shippingAddress.line1,
    ...(contact.shippingAddress.line2 ? { street2: contact.shippingAddress.line2 } : {}),
    city: contact.shippingAddress.city,
    state_code: contact.shippingAddress.state,
    postcode: contact.shippingAddress.zip,
    country_code: contact.shippingAddress.country,
    phone_number: contact.phone,
  };

  // From here on, provider and transport text may echo the recipient, so every
  // failure is fixed text. The caller's durable fence keeps each one ambiguous.
  let res: Response;
  try {
    res = await _fetch(`${getBaseUrl()}/print-jobs/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': LULU_USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Lulu API transport failed; outcome requires reconciliation');
  }

  if (!res.ok) {
    // The request carries the recipient, so the provider's reply may echo it.
    throw new Error(`Lulu API error ${res.status}`);
  }

  let data: {
    id?: number | string;
    status?: string;
    estimated_shipping_dates?: { earliest?: string };
  };
  try {
    data = await res.json();
  } catch {
    throw new Error('Lulu API success response was not JSON; outcome requires reconciliation');
  }

  const providerId = data?.id;
  const jobId = typeof providerId === 'number' || typeof providerId === 'string' ? String(providerId) : '';
  if (!LULU_PRINT_JOB_ID.test(jobId)) {
    throw new Error('Lulu API success response missing print job id; outcome requires reconciliation');
  }
  const earliest = data?.estimated_shipping_dates?.earliest;

  return {
    jobId,
    status: 'submitted',
    ...(typeof earliest === 'string' && LULU_SHIP_DATE.test(earliest) ? { estimatedShipDate: earliest } : {}),
  };
}

// ── Print-job cost calculation (no print job is created) ──────────────────────

export interface LuluCostCalculationInput {
  podPackageId: string;
  pageCount: number;
  quantity?: number;
  shippingAddress: PrintUpgradeShippingAddress;
  shippingLevel: string;
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
  const address = input.shippingAddress;
  const body = {
    line_items: [{ pod_package_id: input.podPackageId, page_count: input.pageCount, quantity }],
    shipping_address: {
      name: address.name,
      street1: address.line1,
      ...(address.line2 ? { street2: address.line2 } : {}),
      city: address.city,
      state_code: address.state,
      postcode: address.zip,
      country_code: address.country,
      phone_number: process.env.LULU_FALLBACK_PHONE ?? '000-000-0000',
    },
    shipping_option: input.shippingLevel,
  };
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
    // The request carries the recipient, so the provider's reply may echo it.
    throw new Error(`Lulu cost calculation error ${res.status}`);
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
