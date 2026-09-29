/**
 * Meta browser pixel — a default-off CANDIDATE. Nothing mounts or calls it yet.
 *
 * It loads no third-party script. Meta's `fbevents.js` collects the full page
 * URL (query string included), the referrer, and on-page text on its own, none
 * of which can be pinned to this contract, so the candidate instead sends one
 * image beacon whose every parameter is set here: the pixel id, a closed event
 * name, and a sanitized `dl` of the canonical origin plus an approved route
 * template. No custom data, no Advanced Matching, no referrer (the request is
 * sent with `referrerPolicy: 'no-referrer'`), no cookie or storage read.
 *
 * Every gate refuses before a URL is built or a transport is touched:
 *   1. explicit public configuration — `NEXT_PUBLIC_HSB_META_PIXEL_ENABLED`
 *      exactly `true` and a well-formed `NEXT_PUBLIC_HSB_META_PIXEL_ID`;
 *   2. a production deployment (`NEXT_PUBLIC_VERCEL_ENV === 'production'`);
 *   3. the canonical host, exactly (`https://herostorybooks.com`, no port);
 *   4. granted marketing consent — which cannot happen today, because HSB has
 *      no consent surface; `readMarketingConsent()` is always `unknown`;
 *   5. an event the Meta contract allows in the browser (PageView,
 *      InitiateCheckout — never Purchase), on a route that event allows.
 */
import { META_EVENT_CONTRACT, type MetaEventSpec } from './analytics-event-contract.ts';
import { sanitizeLandingPath } from './attribution-contract.ts';
import { PRODUCTION_ORIGIN } from './site-url.ts';

export const META_PIXEL_ENDPOINT = 'https://www.facebook.com/tr';
export const META_PIXEL_REQUEST_INIT: Readonly<RequestInit> = Object.freeze({
  method: 'GET',
  mode: 'no-cors',
  credentials: 'include',
  referrerPolicy: 'no-referrer',
  keepalive: true,
  cache: 'no-store',
});

const PIXEL_ID_RE = /^\d{15,16}$/;
const CANONICAL = new URL(PRODUCTION_ORIGIN);

export interface MetaPixelEnv {
  NEXT_PUBLIC_HSB_META_PIXEL_ID?: string;
  NEXT_PUBLIC_HSB_META_PIXEL_ENABLED?: string;
  NEXT_PUBLIC_VERCEL_ENV?: string;
}

export interface MetaPixelPublicConfig {
  pixelId: string | null;
  enabled: boolean;
}

/** Only the two HSB-prefixed public names configure the candidate; nothing else does. */
export function readMetaPixelPublicConfig(env: Record<string, string | undefined>): MetaPixelPublicConfig {
  const id = env.NEXT_PUBLIC_HSB_META_PIXEL_ID;
  return {
    pixelId: typeof id === 'string' && PIXEL_ID_RE.test(id) ? id : null,
    enabled: env.NEXT_PUBLIC_HSB_META_PIXEL_ENABLED === 'true',
  };
}

/** The build's public configuration, read literally so Next can inline it. */
function buildEnv(): MetaPixelEnv {
  if (typeof process === 'undefined') return {};
  return {
    NEXT_PUBLIC_HSB_META_PIXEL_ID: process.env.NEXT_PUBLIC_HSB_META_PIXEL_ID,
    NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: process.env.NEXT_PUBLIC_HSB_META_PIXEL_ENABLED,
    NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  };
}

export type MarketingConsent = 'granted' | 'denied' | 'unknown';

/**
 * HSB has no marketing-consent surface, so no durable consent exists to read.
 * Storage, cookies and globals are deliberately not consulted: a value any
 * script or extension can write is not consent.
 */
export function readMarketingConsent(): MarketingConsent {
  return 'unknown';
}

export type MetaPixelRefusal =
  | 'disabled'
  | 'not_configured'
  | 'not_production'
  | 'no_browser'
  | 'noncanonical_host'
  | 'no_consent'
  | 'event_not_allowed'
  | 'route_not_allowed'
  | 'transport_failed';

type LocationLike = Pick<URL, 'protocol' | 'hostname' | 'port'>;

export function resolveMetaPixelActivation(input: {
  config: MetaPixelPublicConfig;
  deploymentEnv: string | undefined;
  location: LocationLike | null;
  consent: unknown;
}): { active: true; pixelId: string } | { active: false; reason: MetaPixelRefusal } {
  const refuse = (reason: MetaPixelRefusal) => ({ active: false as const, reason });
  if (input.config?.enabled !== true) return refuse('disabled');
  const pixelId = input.config.pixelId;
  if (typeof pixelId !== 'string' || !PIXEL_ID_RE.test(pixelId)) return refuse('not_configured');
  if (input.deploymentEnv !== 'production') return refuse('not_production');
  if (!input.location) return refuse('no_browser');
  const { protocol, hostname, port } = input.location;
  if (protocol !== CANONICAL.protocol || hostname !== CANONICAL.hostname || port !== CANONICAL.port) {
    return refuse('noncanonical_host');
  }
  if (input.consent !== 'granted') return refuse('no_consent');
  return { active: true, pixelId };
}

function browserEventSpec(event: unknown): MetaEventSpec | null {
  if (typeof event !== 'string' || !Object.prototype.hasOwnProperty.call(META_EVENT_CONTRACT, event)) return null;
  const spec = META_EVENT_CONTRACT[event as keyof typeof META_EVENT_CONTRACT] as MetaEventSpec;
  return spec.browser === 'allowed' && spec.transport === 'browser_image_beacon' ? spec : null;
}

export interface MetaPixelDeps {
  env?: MetaPixelEnv;
  location?: (LocationLike & Pick<URL, 'pathname'>) | null;
  consent?: MarketingConsent;
  fetchImpl?: typeof fetch;
}

/**
 * Send one allowed browser event, or refuse with a reason. Takes no event
 * properties: the beacon's parameters are fixed by the contract. Never throws.
 */
export function emitMetaPixelEvent(
  event: 'PageView' | 'InitiateCheckout',
  deps: MetaPixelDeps = {},
): { sent: true } | { sent: false; reason: MetaPixelRefusal } {
  const refuse = (reason: MetaPixelRefusal) => ({ sent: false as const, reason });
  const spec = browserEventSpec(event);
  if (!spec) return refuse('event_not_allowed');
  const env = deps.env ?? buildEnv();
  const location = deps.location ?? (typeof window === 'undefined' ? null : window.location ?? null);
  const activation = resolveMetaPixelActivation({
    config: readMetaPixelPublicConfig(env as Record<string, string | undefined>),
    deploymentEnv: env.NEXT_PUBLIC_VERCEL_ENV,
    location,
    consent: deps.consent ?? readMarketingConsent(),
  });
  if (activation.active === false) return refuse(activation.reason);
  const route = sanitizeLandingPath(location!.pathname);
  if (route === null || !spec.routes.includes(route)) return refuse('route_not_allowed');
  const url = `${META_PIXEL_ENDPOINT}?id=${activation.pixelId}&ev=${event}`
    + `&dl=${encodeURIComponent(`${PRODUCTION_ORIGIN}${route}`)}&noscript=1`;
  try {
    const pending = (deps.fetchImpl ?? fetch)(url, { ...META_PIXEL_REQUEST_INIT });
    void Promise.resolve(pending).catch(() => {});
  } catch {
    return refuse('transport_failed');
  }
  return { sent: true };
}
