import type { OrderRecord } from './orders.ts';

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
  deps: LuluDeps = {},
): Promise<LuluJobResult> {
  const clientKey = process.env.LULU_CLIENT_KEY;
  const clientSecret = process.env.LULU_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    throw new Error(
      'LULU_CLIENT_KEY and LULU_CLIENT_SECRET are required — configure the Lulu integration first.',
    );
  }
  const addr = order.shippingAddress;
  if (!addr?.line1?.trim() || !addr.city?.trim() || !addr.state?.trim() || !addr.zip?.trim() || !addr.country?.trim()) {
    throw new Error('Refusing Lulu print submission: missing usable shippingAddress');
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
    name: order.childName,
    street1: addr.line1,
    ...(addr.line2 ? { street2: addr.line2 } : {}),
    city: addr.city,
    state_code: addr.state,
    postcode: addr.zip,
    country_code: addr.country,
    phone_number: process.env.LULU_FALLBACK_PHONE ?? '000-000-0000',
  };

  const res = await _fetch(`${getBaseUrl()}/print-jobs/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // Server-side idempotency key. Keyed off the HSB order id so that
      // any retransmission of the same logical request — whether from
      // an internal retry, a Vercel/edge replay, or operator
      // double-click — dedupes at Lulu instead of creating a second
      // physical print job. Lulu's print-jobs API accepts this header;
      // see the Lulu print API docs. Combined with our removal of
      // automatic provider-submit retry in `submitPrintAfterOwnerGo`,
      // this gives us defense-in-depth against duplicate paid prints.
      'Idempotency-Key': order.id,
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

  const jobId = data.id != null ? String(data.id) : `lulu-${Date.now()}`;

  return {
    jobId,
    status: 'submitted',
    ...(data.estimated_shipping_dates?.earliest
      ? { estimatedShipDate: data.estimated_shipping_dates.earliest }
      : {}),
  };
}
