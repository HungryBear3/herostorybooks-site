import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Stripe success URL lands in browser history, referrer headers, and
// anything that records page location. It must therefore carry only opaque
// reconciliation ids — never customer-entered names or email addresses.
// `src/app/api/order/route.ts` cannot be imported under `node:test`
// (next/server + Stripe), so this reconstructs the URL contract from source.
// The reconstruction is deliberately a real bracket-balanced parse rather than
// line-oriented regexes: a one-line object literal is an ordinary way to write
// this code and must not be able to slip PII past the audit.
const orderRoute = readFileSync('src/app/api/order/route.ts', 'utf8');
const thankYouPage = readFileSync('src/app/thank-you/page.tsx', 'utf8');

const ALLOWED_SUCCESS_QUERY_KEYS = ['orderId', 'sessionId'];
const ALLOWED_THANK_YOU_URL_KEYS = ['orderId', 'sessionId'];
const SUCCESS_URL_PATH = '/thank-you';
const PII_TOKEN =
  /\b(childName|heroName|firstName|lastName|parentName|customerName|email|phone|address|formatLabel|format|giftMessage|characterNotes|dedication)\b/i;

// ---------------------------------------------------------------------------
// Minimal source parsing helpers. They understand strings, template literals,
// comments, and nesting, so they cannot be defeated by reformatting.
// ---------------------------------------------------------------------------

const OPENERS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const TOKEN_PATTERN = /\u0000(\d+)\u0000/g;

function endOfStringLiteral(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i = matchingBracketEnd(source, i + 1);
      continue;
    }
    if (ch === quote) return i;
  }
  return assert.fail(`unterminated string literal at offset ${start}`);
}

function matchingBracketEnd(source: string, start: number): number {
  assert.ok(OPENERS[source[start]], `expected a bracket at offset ${start}`);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { i = endOfStringLiteral(source, i); continue; }
    if (OPENERS[ch]) { depth += 1; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return assert.fail(`unbalanced bracket opened at offset ${start}`);
}

function splitTopLevel(source: string, separators = ','): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { i = endOfStringLiteral(source, i); continue; }
    if (OPENERS[ch]) { i = matchingBracketEnd(source, i); continue; }
    if (separators.includes(ch)) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

type Entry = { key: string; value: string; raw: string };

// Parses an object literal (or an object destructuring pattern) whose opening
// brace is at `braceStart`. Spreads and computed keys are rejected outright:
// an audit that cannot enumerate the keys must not silently pass.
function objectEntries(source: string, braceStart: number, separators = ','): Entry[] {
  const end = matchingBracketEnd(source, braceStart);
  return splitTopLevel(source.slice(braceStart + 1, end), separators).map((raw) => {
    assert.doesNotMatch(
      raw,
      /^\.\.\./,
      `spread is not auditable and is not allowed where URL keys are decided: ${raw}`,
    );
    const named = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\??\s*(:|=|$)/.exec(raw);
    assert.ok(named, `unanalyzable object entry (computed or dynamic key): ${raw}`);
    const key = named[1] ?? named[2] ?? named[3];
    const value = named[4] === ':' || named[4] === '=' ? raw.slice(named[0].length).trim() : key;
    return { key, value, raw };
  });
}

function encodeTemplate(raw: string): { text: string; exprs: string[] } {
  const exprs: string[] = [];
  let text = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') { text += raw.slice(i, i + 2); i += 1; continue; }
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const end = matchingBracketEnd(raw, i + 1);
      exprs.push(raw.slice(i + 2, end).trim());
      text += `\u0000${exprs.length - 1}\u0000`;
      i = end;
      continue;
    }
    text += raw[i];
  }
  return { text, exprs };
}

const tokensIn = (segment: string, exprs: string[]): string[] =>
  [...segment.matchAll(TOKEN_PATTERN)].map((match) => exprs[Number(match[1])]);

const literalOf = (segment: string): string => segment.replace(TOKEN_PATTERN, '');

// ---------------------------------------------------------------------------
// The checkout success URL, reconstructed.
// ---------------------------------------------------------------------------

function checkoutSessionSource(): string {
  const start = orderRoute.indexOf('async function createDirectCheckoutSession');
  assert.notEqual(start, -1, 'expected createDirectCheckoutSession in the checkout route');
  return orderRoute.slice(start);
}

function searchParamsEntries(source: string, variableName: string): Entry[] {
  const declaration = new RegExp(`\\b${variableName}\\s*=\\s*new URLSearchParams\\s*\\(`).exec(source);
  assert.ok(declaration, `expected a URLSearchParams constructor for ${variableName}`);
  const argsStart = declaration.index + declaration[0].length - 1;
  const args = source.slice(argsStart + 1, matchingBracketEnd(source, argsStart));
  const braceOffset = args.indexOf('{');
  assert.notEqual(
    braceOffset,
    -1,
    `${variableName} must be built from an inline object literal so its keys are auditable`,
  );
  assert.equal(
    args.slice(0, braceOffset).trim(),
    '',
    `${variableName} must be built from an inline object literal only: ${args.trim()}`,
  );
  return objectEntries(source, argsStart + 1 + braceOffset);
}

type QueryPair = { key: string; value: string; origin: string };

type SuccessUrl = {
  raw: string;
  path: string;
  pathExprs: string[];
  pairs: QueryPair[];
};

function successUrl(): SuccessUrl {
  const source = checkoutSessionSource();
  const marker = /success_url:\s*/.exec(source);
  assert.ok(marker, 'expected a success_url on the checkout session');
  const templateStart = marker.index + marker[0].length;
  assert.equal(
    source[templateStart],
    '`',
    'success_url must be a template literal so its query is auditable',
  );
  const raw = source.slice(templateStart + 1, endOfStringLiteral(source, templateStart));
  const { text, exprs } = encodeTemplate(raw);

  // A fragment is not sent to the server but still lives in history and in the
  // page's own `location`, so it is no safer a hiding place than the query.
  assert.equal(text.includes('#'), false, 'success URL must not carry a fragment');

  const [pathText, ...queryTexts] = text.split('?');
  assert.equal(queryTexts.length, 1, 'expected exactly one query string on the success URL');

  const pairs: QueryPair[] = [];
  for (const chunk of queryTexts[0].split('&')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const wholeToken = /^\u0000(\d+)\u0000$/.exec(trimmed);
    if (wholeToken) {
      const expr = exprs[Number(wholeToken[1])];
      const params = /^([A-Za-z_$][\w$]*)\.toString\(\)$/.exec(expr);
      assert.ok(params, `unanalyzable success URL query segment: \${${expr}}`);
      for (const entry of searchParamsEntries(source, params[1])) {
        pairs.push({ key: entry.key, value: entry.value, origin: `${params[1]} object literal` });
      }
      continue;
    }
    const equals = trimmed.indexOf('=');
    assert.notEqual(equals, -1, `success URL query segment has no value: ${trimmed}`);
    const key = trimmed.slice(0, equals);
    assert.doesNotMatch(
      key,
      /\u0000\d+\u0000/,
      `success URL query keys must be literal, not interpolated: ${literalOf(key)}`,
    );
    pairs.push({ key, value: trimmed.slice(equals + 1), origin: 'success_url template' });
  }

  return { raw, path: literalOf(pathText), pathExprs: tokensIn(pathText, exprs), pairs };
}

// ---------------------------------------------------------------------------
// Parser self-checks. These guard the audit itself: an earlier revision used a
// line-anchored regex and a single-line object literal walked straight past it.
// ---------------------------------------------------------------------------

test('audit parser enumerates object keys regardless of formatting', () => {
  const inline = '({ orderId: order.id, childName: order.heroName ?? order.childName, email: order.email })';
  assert.deepEqual(
    objectEntries(inline, 1).map((entry) => entry.key),
    ['orderId', 'childName', 'email'],
  );

  const multiline = '({\n  orderId: order.id,\n  nested: { a: 1, b: 2 },\n  label: `x, y`,\n})';
  assert.deepEqual(
    objectEntries(multiline, 1).map((entry) => entry.key),
    ['orderId', 'nested', 'label'],
  );

  assert.throws(
    () => objectEntries('({ ...extra, orderId: order.id })', 1),
    /spread is not auditable/,
  );
  assert.throws(() => objectEntries('({ [key]: order.email })', 1), /unanalyzable object entry/);
});

// ---------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------

test('success URL carries exactly the opaque reconciliation ids', () => {
  const keys = successUrl().pairs.map((pair) => pair.key);
  assert.deepEqual([...keys].sort(), [...ALLOWED_SUCCESS_QUERY_KEYS].sort());
  assert.equal(keys.length, new Set(keys).size, 'success URL query keys must not repeat');
});

test('success URL never carries customer-entered values', () => {
  const url = successUrl();
  for (const pair of url.pairs) {
    assert.doesNotMatch(
      pair.key,
      PII_TOKEN,
      `success URL must not expose "${pair.key}" in the browser URL (${pair.origin})`,
    );
    assert.doesNotMatch(
      pair.value,
      PII_TOKEN,
      `success URL key "${pair.key}" must not be fed customer data: ${pair.value} (${pair.origin})`,
    );
  }
  // Belt and braces: nothing customer-entered anywhere in the URL expression.
  assert.doesNotMatch(url.raw, PII_TOKEN);
});

test('success URL values are the order id and the Stripe session placeholder only', () => {
  const pairs = new Map(successUrl().pairs.map((pair) => [pair.key, pair.value]));
  assert.equal(pairs.get('orderId'), 'order.id');
  assert.equal(pairs.get('sessionId'), '{CHECKOUT_SESSION_ID}');
});

test('success URL path and fragment cannot smuggle customer data', () => {
  const url = successUrl();
  assert.equal(url.path, SUCCESS_URL_PATH);
  assert.deepEqual(url.pathExprs, ['baseUrl'], 'the success URL path may interpolate only baseUrl');
});

test('success URL query params are not mutated after construction', () => {
  const source = checkoutSessionSource();
  assert.doesNotMatch(source, /\b[A-Za-z_$][\w$]*\.(?:set|append)\s*\(/);
  assert.doesNotMatch(source, /Object\.assign\s*\(\s*[A-Za-z_$][\w$]*Params/);
});

test('checkout session still binds email and order id off the URL, server-side', () => {
  const source = checkoutSessionSource();
  assert.match(source, /customer_email:\s*order\.email/);
  assert.match(source, /client_reference_id:\s*order\.id/);
  assert.match(source, /metadata:\s*\{[\s\S]*?orderId:\s*order\.id/);
  assert.match(source, /payment_intent_data:\s*\{\s*metadata:\s*\{\s*orderId:\s*order\.id/);
});

// ---------------------------------------------------------------------------
// The reader side: the thank-you page must not accept customer data from the
// URL either, whether by member access, by destructuring, or by type.
// ---------------------------------------------------------------------------

function thankYouSearchParamTypeKeys(): string[] {
  const marker = /searchParams\??\s*:\s*Promise<\s*\{/.exec(thankYouPage);
  assert.ok(marker, 'expected a typed searchParams prop on the thank-you page');
  const braceStart = marker.index + marker[0].length - 1;
  return objectEntries(thankYouPage, braceStart, ',;').map((entry) => entry.key);
}

function thankYouUrlParamReads(): string[] {
  const reads = [...thankYouPage.matchAll(/\bparams\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  for (const match of thankYouPage.matchAll(/(?:const|let|var)\s*\{/g)) {
    const braceStart = match.index + match[0].length - 1;
    const end = matchingBracketEnd(thankYouPage, braceStart);
    const assigned = /^\s*(?::[^=]*)?=\s*\(?\s*(?:await\s+)?([A-Za-z_$][\w$]*)/.exec(
      thankYouPage.slice(end + 1),
    );
    if (!assigned || !['params', 'searchParams'].includes(assigned[1])) continue;
    reads.push(...objectEntries(thankYouPage, braceStart).map((entry) => entry.key));
  }
  return reads;
}

test('thank-you page reads no customer PII out of the URL', () => {
  for (const key of [...thankYouUrlParamReads(), ...thankYouSearchParamTypeKeys()]) {
    assert.doesNotMatch(key, PII_TOKEN, `thank-you page must not read "${key}" from the URL`);
    assert.equal(
      ALLOWED_THANK_YOU_URL_KEYS.includes(key),
      true,
      `thank-you page reads an unaudited URL param: ${key}`,
    );
  }
});

test('thank-you page sources customer copy from the order record only', () => {
  for (const field of ['childName', 'format', 'email']) {
    const assignment = new RegExp(`\\bconst ${field} = ([^;]+);`).exec(thankYouPage);
    assert.ok(assignment, `expected the thank-you page to derive ${field}`);
    assert.doesNotMatch(
      assignment[1],
      /\bparams\b/,
      `${field} must come from the order record, not the URL: ${assignment[1]}`,
    );
    assert.match(assignment[1], /\border\?\./);
  }
});

test('thank-you page still reads the opaque order and session ids', () => {
  const reads = thankYouUrlParamReads();
  assert.equal(reads.includes('orderId'), true);
  assert.equal(reads.includes('sessionId'), true);
  assert.match(thankYouPage, /await getOrder\(orderIdParam\)/);
});
