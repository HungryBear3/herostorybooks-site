// Redact key-shaped / secret-shaped content from strings before they are
// persisted to durable order fields (fulfillmentLastError, storyMeta.fallbackError),
// audit metadata, or logs. Provider error bodies routinely echo the offending
// credential — e.g. an OpenAI 401 body contains
//   "Incorrect API key provided: sk-proj-XXXX..."
// and the codebase persists `error.slice(0, 200)`, which would otherwise land a
// partial key in order records. This is defense-in-depth: never persist secrets.

const REDACTED = '[redacted-secret]';

// Token patterns for well-known credential shapes. Anchored on stable prefixes
// so we do not redact ordinary IDs/URLs.
const SECRET_PATTERNS: RegExp[] = [
  /sk-proj-[A-Za-z0-9_-]{6,}/g,      // OpenAI project keys
  /sk-ant-[A-Za-z0-9_-]{6,}/g,       // Anthropic keys
  /sk-[A-Za-z0-9_-]{12,}/g,          // OpenAI/legacy keys
  /AIza[A-Za-z0-9_-]{10,}/g,         // Google API keys
  /\b(?:key|fal)-[A-Za-z0-9_-]{8,}/gi, // FAL / generic key- tokens
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, // Authorization bearer tokens
  /\bxoxb-[A-Za-z0-9-]{8,}/g,        // Slack-style tokens
];

// Phrases that are commonly followed by the raw credential in provider errors.
const ECHO_PHRASES = /\b(API key provided|api[_-]?key|apikey|token|secret|authorization)\b\s*[:=]?\s*['"]?[A-Za-z0-9._-]{8,}/gi;

export function redactSecrets(input: unknown): string {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : String(input);
  // First collapse "phrase: <value>" echoes so we don't keep the value even if
  // it doesn't match a known key prefix.
  s = s.replace(ECHO_PHRASES, (m) => {
    const sep = m.search(/[:=]/);
    const head = sep >= 0 ? m.slice(0, sep + 1) : m.split(/\s+/)[0];
    return `${head} ${REDACTED}`;
  });
  for (const re of SECRET_PATTERNS) s = s.replace(re, REDACTED);
  return s;
}

/**
 * Centralized provider-error redactor. The raw body of an OpenAI/FAL/Gemini/
 * Seedream error (HTTP response text or a thrown Error's message) routinely
 * echoes BOTH credentials AND customer PII (a child's name the prompt embedded)
 * or internal prompt text. `redactSecrets` only removes credential-shaped
 * tokens — a name would survive. So before persisting a provider error to an
 * order artifact, Blob, Vercel log, or any customer-reachable field, keep only
 * a stable type/code classifier (provider label + HTTP status + Error name) and
 * DROP the message body entirely. Defense-in-depth: the classifier is still run
 * through `redactSecrets` in case a status line embedded a token.
 *
 * Returns e.g. "FAL 429", "OpenAI 401", "fal AbortError", or "provider_error".
 */
export function redactProviderError(
  err: unknown,
  opts?: { provider?: string; status?: number },
): string {
  const parts: string[] = [];
  if (opts?.provider) parts.push(opts.provider);
  let code: string | number | undefined = opts?.status;
  if (code === undefined && err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const sniffed = e.status ?? e.statusCode ?? e.code;
    if (typeof sniffed === 'number') code = sniffed;
    else if (typeof sniffed === 'string' && sniffed.length > 0 && sniffed.length <= 40) code = sniffed;
  }
  if (code !== undefined && String(code).length > 0) parts.push(String(code));
  if (err instanceof Error && err.name && !parts.includes(err.name)) parts.push(err.name);
  const label = parts.join(' ').trim() || 'provider_error';
  return redactSecrets(label).slice(0, 80);
}
