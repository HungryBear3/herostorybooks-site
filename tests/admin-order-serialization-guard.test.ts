/*
 * L-4 Slice A3-1 — the guard that keeps the boundary closed.
 *
 * `tests/admin-order-dto.test.ts` proves the three surfaces emit projections
 * today. This file proves they cannot quietly stop: a type-aware walk of every
 * file under `src/app` fails if a value whose type is (or contains) an
 * `OrderRecord` reaches `NextResponse.json` / `Response.json`, or reaches a
 * prop of a component declared in a `'use client'` module.
 *
 * The check runs against the TypeScript checker rather than against source
 * text, because text cannot follow a renamed binding: `const rows = orders;
 * NextResponse.json({ orders: rows })` reads clean and leaks everything. Source
 * assertions are kept as a second, cheaper layer — not as the primary proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DTO_MODULE = 'src/lib/admin-order-dto.ts';
const LIST_ROUTE = 'src/app/api/admin/orders/route.ts';
const DETAIL_ROUTE = 'src/app/api/admin/orders/[orderId]/route.ts';
const LIST_PAGE = 'src/app/admin/orders/page.tsx';
const OPS_CLIENT = 'src/app/admin/orders/ops-client.tsx';

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// ── The type-aware boundary walk ───────────────────────────────────────────

/** Files whose first statement is the `'use client'` directive. */
function isClientModule(fileName: string): boolean {
  let text: string;
  try {
    text = readFileSync(fileName, 'utf8');
  } catch {
    return false;
  }
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*['"]use client['"]/.test(text);
}

interface Finding {
  where: string;
  detail: string;
}

function buildProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(raw.error, undefined, 'tsconfig.json must parse');
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, REPO_ROOT);
  const rootNames = walk(path.join(REPO_ROOT, 'src', 'app'));
  rootNames.push(path.join(REPO_ROOT, DTO_MODULE));
  const program = ts.createProgram({
    rootNames,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true },
  });
  return { program, checker: program.getTypeChecker() };
}

/**
 * Does this type carry an `OrderRecord` anywhere a serializer would reach?
 *
 * Unions are inspected member by member, arrays by element, and object types by
 * property — because `{ orders: OrderRecord[] }` is the exact shape the three
 * old sinks used, and the record never appeared at the top level there.
 */
function carriesOrderRecord(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
  seen = new Set<ts.Type>(),
): boolean {
  if (depth > 6 || seen.has(type)) return false;
  seen.add(type);

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol && symbol.getName() === 'OrderRecord') return true;

  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => carriesOrderRecord(checker, member, depth + 1, seen));
  }

  const elementTypes = checker.getTypeArguments(type as ts.TypeReference);
  if (elementTypes.length > 0 && checker.isArrayType(type)) {
    return elementTypes.some((member) => carriesOrderRecord(checker, member, depth + 1, seen));
  }

  for (const property of type.getProperties()) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    if (carriesOrderRecord(checker, propertyType, depth + 1, seen)) return true;
  }

  return false;
}

function isResponseJsonCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'json') return false;
  const base = callee.expression.getText();
  return base === 'NextResponse' || base === 'Response';
}

function collectFindings(program: ts.Program, checker: ts.TypeChecker): Finding[] {
  const findings: Finding[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const relative = path.relative(REPO_ROOT, sourceFile.fileName);
    if (!relative.startsWith(`src${path.sep}app`)) continue;

    const visit = (node: ts.Node): void => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      if (isResponseJsonCall(node) && node.arguments.length > 0) {
        const argument = node.arguments[0];
        if (carriesOrderRecord(checker, checker.getTypeAtLocation(argument))) {
          findings.push({
            where: `${relative}:${line}`,
            detail: `a value carrying OrderRecord reaches ${node.expression.getText()}`,
          });
        }
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
          let symbol = checker.getSymbolAtLocation(tag);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const declaredIn = symbol?.declarations?.[0]?.getSourceFile().fileName;
          if (declaredIn && isClientModule(declaredIn)) {
            for (const property of node.attributes.properties) {
              if (!ts.isJsxAttribute(property)) continue;
              const initializer = property.initializer;
              if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) continue;
              if (carriesOrderRecord(checker, checker.getTypeAtLocation(initializer.expression))) {
                findings.push({
                  where: `${relative}:${line}`,
                  detail: `prop ${property.name.getText()} of client component <${tag.text}> carries OrderRecord`,
                });
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return findings;
}

const { program, checker } = buildProgram();
const FINDINGS = collectFindings(program, checker);

test('A3-1: no OrderRecord reaches an HTTP response or a client component prop', () => {
  assert.deepEqual(
    FINDINGS,
    [],
    `raw OrderRecord values still cross a boundary:\n${FINDINGS.map((f) => `${f.where} — ${f.detail}`).join('\n')}`,
  );
});

test('A3-1: the guard is wired to a real program, not an empty one', () => {
  // A walk that found no `src/app` files would pass the assertion above for the
  // wrong reason. Pin that it actually looked at the three surfaces.
  const inspected = program
    .getSourceFiles()
    .map((file) => path.relative(REPO_ROOT, file.fileName))
    .filter((relative) => relative.startsWith(`src${path.sep}app`));
  for (const required of [LIST_ROUTE, DETAIL_ROUTE, LIST_PAGE, OPS_CLIENT]) {
    assert.ok(
      inspected.includes(required.split('/').join(path.sep)),
      `${required} must be inside the guarded program`,
    );
  }
  assert.ok(inspected.length > 20, 'the guarded program must cover the app tree');
});

test('A3-1: the guard recognizes a raw handoff when one is present', () => {
  // The detector is exercised against a synthetic in-memory program rather than
  // by editing the candidate, so the guard is shown to fire rather than assumed
  // to. Both old shapes are covered: `{ orders }` and a renamed binding.
  const source = `
    import type { OrderRecord } from '${path.join(REPO_ROOT, 'src/lib/orders.ts').split(path.sep).join('/')}';
    declare const NextResponse: { json(body: unknown): Response };
    declare const orders: OrderRecord[];
    export function GET() {
      const rows = orders;
      return NextResponse.json({ orders: rows });
    }
  `;
  const fileName = path.join(REPO_ROOT, 'src', 'app', '__a31_guard_probe.ts');
  const host = ts.createCompilerHost({ skipLibCheck: true });
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => (name === fileName ? true : ts.sys.fileExists(name));
  host.readFile = (name) => (name === fileName ? source : ts.sys.readFile(name));

  const probeProgram = ts.createProgram({
    rootNames: [fileName],
    options: { skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, target: ts.ScriptTarget.ES2017 },
    host,
  });
  const probeFindings = collectFindings(probeProgram, probeProgram.getTypeChecker());
  assert.equal(probeFindings.length, 1, 'the detector must fire on a raw `{ orders }` handoff');
  assert.match(probeFindings[0].detail, /carrying OrderRecord reaches NextResponse\.json/);
});

// ── The client bundle boundary ─────────────────────────────────────────────

test('A3-1: no client module names OrderRecord at all', () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(REPO_ROOT, 'src'))) {
    if (!isClientModule(file)) continue;
    if (readFileSync(file, 'utf8').includes('OrderRecord')) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `client modules still reference OrderRecord:\n${offenders.join('\n')}`);
});

test('A3-1: ops-client imports the DTO as a type and value-imports only react', () => {
  const source = read(OPS_CLIENT);
  assert.match(source, /^'use client';/);
  assert.match(
    source,
    /import type \{ AdminOrderListItem \} from '@\/lib\/admin-order-dto';/,
    'the DTO must arrive as a type-only import',
  );

  const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)];
  assert.ok(imports.length >= 2, 'the import block must be readable');
  for (const [, typeOnly, specifier] of imports) {
    if (typeOnly) continue;
    assert.equal(
      specifier,
      'react',
      `ops-client value-imports ${specifier}; only react may be a runtime import`,
    );
  }
  // And the derivations it used to run in the browser are gone.
  assert.doesNotMatch(source, /deriveOrderAttention|deriveOrderStage/);
  assert.match(source, /order\.stage/);
  assert.match(source, /order\.attention/);
});

test('A3-1: ops-client reaches no server-only module, transitively', () => {
  const FORBIDDEN = ['/lib/orders.ts', '@vercel/blob', 'stripe', 'next/server', 'resend'];
  const start = path.join(REPO_ROOT, OPS_CLIENT);
  const visited = new Set<string>();
  const queue: string[] = [start];
  const reached: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, 'utf8');
    for (const match of source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)) {
      const [, typeOnly, specifier] = match;
      if (typeOnly) continue; // erased at build; carries nothing into the bundle
      for (const forbidden of FORBIDDEN) {
        if (specifier.includes(forbidden)) reached.push(`${path.relative(REPO_ROOT, current)} -> ${specifier}`);
      }
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const resolved = specifier.startsWith('@/')
          ? path.join(REPO_ROOT, 'src', specifier.slice(2))
          : path.resolve(path.dirname(current), specifier);
        for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`]) {
          try {
            if (statSync(candidate).isFile()) { queue.push(candidate); break; }
          } catch { /* not this extension */ }
        }
      }
    }
  }

  assert.deepEqual(reached, [], `the client bundle reaches server-only modules:\n${reached.join('\n')}`);
  assert.ok(visited.size >= 1);
});

// ── How the DTO is built ───────────────────────────────────────────────────

test('A3-1: the DTO module builds fresh literals and performs no I/O', () => {
  const source = read(DTO_MODULE);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const [pattern, why] of [
    [/\.\.\.\s*order\b/, 'spreads the record'],
    [/\.\.\.\s*record\b/, 'spreads a record'],
    [/\bOmit\s*</, 'uses Omit, which is erased at run time'],
    [/\bPick\s*</, 'uses Pick, which is erased at run time'],
    [/\bdelete\s+/, 'redacts by deleting'],
    [/JSON\.parse\s*\(\s*JSON\.stringify/, 'round-trips the record'],
    [/\bfetch\s*\(/, 'performs network I/O'],
    [/process\.env/, 'reads the environment'],
    [/console\./, 'writes to a log sink'],
    [/@vercel\/blob/, 'reaches storage'],
  ] as Array<[RegExp, string]>) {
    assert.doesNotMatch(code, pattern, `src/lib/admin-order-dto.ts ${why}`);
  }

  // Every allowlisted key is assigned by name in both projections.
  for (const key of [
    'id', 'childName', 'email', 'createdAt', 'updatedAt', 'status', 'paymentStatus',
    'fulfillmentStatus', 'fulfillmentLastError', 'storyArtifactUrl', 'refundedAt',
    'formatLabel', 'internalDisposition', 'internalDispositionNote',
    'customerQueueStatus', 'checkoutTracking', 'stage', 'attention',
  ]) {
    const assignments = code.match(new RegExp(`^\\s{4}${key}:`, 'gm')) ?? [];
    assert.equal(assignments.length, 2, `${key} must be assigned by name in both projections`);
  }
});

// ── The three sinks, at source level ───────────────────────────────────────

test('A3-1: the list route projects and still applies the paid-artifact filter', () => {
  const source = read(LIST_ROUTE);
  assert.match(source, /isPaidArtifactOpsIssue\(issue\)/);
  assert.match(source, /NextResponse\.json\(\{ orders: orders\.map\(toAdminOrderListItem\) \}\)/);
  assert.doesNotMatch(source, /NextResponse\.json\(\{\s*orders\s*\}\)/);
});

test('A3-1: the detail route projects', () => {
  const source = read(DETAIL_ROUTE);
  assert.match(source, /NextResponse\.json\(\{ order: toAdminOrderDetail\(order\) \}\)/);
  assert.doesNotMatch(source, /NextResponse\.json\(\{\s*order\s*\}\)/);
});

test('A3-1: the list page projects before the client boundary and keeps its server-only panels', () => {
  const source = read(LIST_PAGE);
  assert.match(source, /<AdminOrdersClient orders=\{orders\.map\(toAdminOrderListItem\)\} \/>/);
  assert.doesNotMatch(source, /<AdminOrdersClient orders=\{orders\} \/>/);
  // Server-side stats and the reconciliation panel still read the full records.
  assert.match(source, /deriveOrderAttention/);
  assert.match(source, /paidIssue\.severity !== 'none'/);
  assert.match(source, /readCheckoutProvisioningEvidence/);
});

test('A3-1: no raw whole-order handoff remains anywhere under src/app', () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(REPO_ROOT, 'src', 'app'))) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of [
      /NextResponse\.json\(\{\s*orders\s*\}\)/,
      /NextResponse\.json\(\{\s*order\s*\}\)/,
      /Response\.json\(\{\s*orders\s*\}\)/,
      /Response\.json\(\{\s*order\s*\}\)/,
    ]) {
      if (pattern.test(source)) offenders.push(`${path.relative(REPO_ROOT, file)} — ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `raw whole-order handoffs remain:\n${offenders.join('\n')}`);
});
