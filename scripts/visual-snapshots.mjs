#!/usr/bin/env node
// HSB visual screenshot + automated launch-QA harness.
//
// Captures full-page screenshots of the customer-facing routes at desktop,
// mobile, and tight-mobile viewports, runs lightweight automated checks per
// page (console errors, failed requests, horizontal overflow, broken images,
// forbidden-string scan), and writes:
//   - per-shot PNGs
//   - report.json  (machine-readable; all captured signals)
//   - report.html  (executive summary + per-route checklist + side-by-side shots)
//   - report.md    (text-only index for quick CLI scanning)
//
// This is QA capture + reporting only — NOT pixel-diff. No production
// behavior is changed; nothing is uploaded; nothing is committed.
//
// Usage:
//   HSB_BASE_URL=http://localhost:3001 npm run visual:snapshots
//
// If HSB_BASE_URL is unset, defaults to http://localhost:3000. If that URL
// is unreachable, the script prints exactly how to start a local server.
// Playwright is required; if missing, the script prints install commands.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.HSB_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const REQUIRED_ROUTES = ['/', '/pricing', '/samples', '/checkout'];
const OPTIONAL_ROUTES = ['/privacy', '/terms', '/thank-you'];
const ALL_ROUTES = [...REQUIRED_ROUTES, ...OPTIONAL_ROUTES];

const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 1000 },
  { id: 'mobile', width: 390, height: 844 },
  { id: 'tight-mobile', width: 320, height: 700 },
];

const NAV_TIMEOUT_MS = Number(process.env.HSB_VISUAL_NAV_TIMEOUT_MS ?? 20_000);
const SETTLE_MS = Number(process.env.HSB_VISUAL_SETTLE_MS ?? 800);

// Forbidden visible strings — these should NOT appear in rendered page text.
// Each entry has a JS-RegExp source + flags. Currency tokens use negative
// lookahead so '$24' does not match '$240' / '$2400'.
const FORBIDDEN_PATTERNS = [
  { name: "Mother's Day", source: "Mother(?:'|\u2019|)s\\s+Day", flags: 'i' },
  { name: 'Digital instant', source: 'Digital\\s+instant', flags: 'i' },
  { name: '$14.99', source: '\\$14\\.99(?!\\d)', flags: 'g' },
  { name: '$24', source: '\\$24(?![\\d.])', flags: 'g' },
  { name: '$29', source: '\\$29(?![\\d.])', flags: 'g' },
  { name: '$49', source: '\\$49(?![\\d.])', flags: 'g' },
  { name: '$59', source: '\\$59(?![\\d.])', flags: 'g' },
  { name: 'lorem', source: 'lorem', flags: 'i' },
  { name: 'TODO', source: '\\bTODO\\b', flags: '' },
  { name: 'FIXME', source: '\\bFIXME\\b', flags: '' },
  // 2026-05-19 hotfix: never leak the real customer surname or the
  // "Made for Lukas …" cover overlay onto a marketing page.
  { name: 'kaplun', source: 'kaplun', flags: 'i' },
  { name: 'made for lukas', source: 'made\\s+for\\s+lukas', flags: 'i' },
  // 2026-05-19 hotfix: catch unrendered apostrophe escapes that slipped
  // through into copy (e.g. "aren’t" appearing literally on /samples).
  { name: '\\u2019 literal', source: '\\\\u2019', flags: '' },
];

// Per-route human-QA checklist. Same checklist for every route; intended as
// a paper-checklist surface inside the HTML report.
const HUMAN_CHECKLIST = [
  'Pricing/copy looks correct',
  'Main CTA visible',
  'Mobile layout readable',
  'Art/imagery acceptable',
  'Proof-before-print trust clear',
  'No weird placeholder / AI artifacts obvious',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugifyRoute(route) {
  if (route === '/') return 'home';
  return route.replace(/^\//, '').replace(/\//g, '__');
}

function timestampDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function pingBaseUrl() {
  try {
    const res = await fetch(BASE_URL + '/', { signal: AbortSignal.timeout(3000) });
    return res.ok || res.status === 404 || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

function printServerInstructions() {
  console.log('');
  console.log(`[visual-snapshots] HSB_BASE_URL is not reachable: ${BASE_URL}`);
  console.log('');
  console.log('Start a local server in another terminal, then re-run this command:');
  console.log('');
  console.log('  # Fastest — Next dev server (no build needed):');
  console.log('  npm run dev');
  console.log('');
  console.log('  # Or — production build + start (closer to Preview):');
  console.log('  npm run build && npm run start');
  console.log('');
  console.log('Then in this terminal:');
  console.log('');
  console.log('  HSB_BASE_URL=http://localhost:3000 npm run visual:snapshots');
  console.log('');
}

function printPlaywrightInstructions() {
  console.log('');
  console.log('[visual-snapshots] Playwright is not installed.');
  console.log('');
  console.log('Minimal install (does not mutate other tooling):');
  console.log('');
  console.log('  npm install --save-dev playwright');
  console.log('  npx playwright install chromium');
  console.log('');
  console.log('Then re-run:');
  console.log('');
  console.log(`  HSB_BASE_URL=${BASE_URL} npm run visual:snapshots`);
  console.log('');
}

// ── Playwright loader ─────────────────────────────────────────────────────────

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

// ── Per-page automated checks ─────────────────────────────────────────────────
//
// Runs inside the page context. Returns shape:
//   { overflow:{scrollWidth,innerWidth,overflows}, brokenImages:[url],
//     forbiddenMatches:[{name,count,samples:[snippets]}] }

const IN_PAGE_CHECK = `
  ({ patterns }) => {
    const overflow = {
      scrollWidth: document.body ? document.body.scrollWidth : 0,
      innerWidth: window.innerWidth,
      overflows: !!(document.body && document.body.scrollWidth > window.innerWidth + 5),
    };
    const brokenImages = Array.from(document.querySelectorAll('img'))
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src)
      .filter(Boolean)
      .slice(0, 10);
    const text = (document.body && document.body.innerText) || '';
    const forbiddenMatches = patterns.map((p) => {
      let count = 0;
      const samples = [];
      try {
        const re = new RegExp(p.source, p.flags || '');
        const isGlobal = (p.flags || '').includes('g');
        if (isGlobal) {
          let m;
          while ((m = re.exec(text)) && samples.length < 5) {
            count += 1;
            const i = Math.max(0, m.index - 20);
            samples.push(text.slice(i, m.index + m[0].length + 20));
            if (m.index === re.lastIndex) re.lastIndex += 1;
          }
        } else {
          const m = text.match(re);
          if (m) {
            count = 1;
            const idx = text.indexOf(m[0]);
            const i = Math.max(0, idx - 20);
            samples.push(text.slice(i, idx + m[0].length + 20));
          }
        }
      } catch (e) {
        // invalid pattern; report zero matches rather than crash the run
      }
      return { name: p.name, count, samples };
    }).filter((x) => x.count > 0);
    return { overflow, brokenImages, forbiddenMatches };
  }
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    printPlaywrightInstructions();
    process.exit(0);
  }

  const reachable = await pingBaseUrl();
  if (!reachable) {
    printServerInstructions();
    process.exit(0);
  }

  const outRoot = path.resolve(process.cwd(), 'visual-reports', timestampDir());
  if (!existsSync(outRoot)) {
    await mkdir(outRoot, { recursive: true });
  }

  console.log(`[visual-snapshots] base=${BASE_URL}`);
  console.log(`[visual-snapshots] out=${outRoot}`);
  console.log(`[visual-snapshots] routes=${ALL_ROUTES.length} viewports=${VIEWPORTS.length} total=${ALL_ROUTES.length * VIEWPORTS.length}`);
  console.log('');

  const browser = await playwright.chromium.launch();
  const captured = []; // one entry per (viewport, route)

  try {
    for (const viewport of VIEWPORTS) {
      for (const route of ALL_ROUTES) {
        const url = `${BASE_URL}${route}`;
        const slug = slugifyRoute(route);
        const fileBase = `${slug}__${viewport.id}.png`;
        const filePath = path.join(outRoot, fileBase);
        const record = {
          route,
          viewport: viewport.id,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          file: fileBase,
          status: 'pending',
          httpStatus: null,
          durationMs: 0,
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          overflow: null,
          brokenImages: [],
          forbiddenMatches: [],
          error: null,
        };
        captured.push(record);

        // Fresh context per (route, viewport) so signals don't leak across pages.
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          userAgent: viewport.width < 1024
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
            : undefined,
        });
        const page = await context.newPage();

        page.on('console', (msg) => {
          if (msg.type() === 'error') record.consoleErrors.push(msg.text().slice(0, 240));
        });
        page.on('pageerror', (err) => {
          record.pageErrors.push(String(err && err.message ? err.message : err).slice(0, 240));
        });
        page.on('requestfailed', (req) => {
          record.failedRequests.push({
            url: req.url().slice(0, 240),
            kind: 'requestfailed',
            detail: (req.failure() && req.failure().errorText) || null,
            resourceType: req.resourceType(),
          });
        });
        page.on('response', (resp) => {
          const status = resp.status();
          if (status >= 400 && resp.url() !== url) {
            record.failedRequests.push({
              url: resp.url().slice(0, 240),
              kind: `http_${status}`,
              detail: null,
              resourceType: resp.request().resourceType(),
            });
          }
        });

        const started = Date.now();
        try {
          const response = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: NAV_TIMEOUT_MS,
          });
          record.httpStatus = response ? response.status() : null;
          if (!response) {
            record.status = 'no_response';
          } else if (!response.ok()) {
            record.status = `http_${response.status()}`;
          } else {
            record.status = 'ok';
          }
          await page.waitForTimeout(SETTLE_MS);

          // Run the automated checks BEFORE screenshot so any forced layout
          // settles before capture.
          try {
            const checks = await page.evaluate(IN_PAGE_CHECK, { patterns: FORBIDDEN_PATTERNS });
            record.overflow = checks.overflow;
            record.brokenImages = checks.brokenImages;
            record.forbiddenMatches = checks.forbiddenMatches;
          } catch (e) {
            record.error = `in-page check failed: ${e && e.message ? e.message : String(e)}`.slice(0, 240);
          }

          await page.screenshot({ path: filePath, fullPage: true });
        } catch (err) {
          record.status = 'error';
          record.error = (err instanceof Error ? err.message : String(err)).slice(0, 240);
        }
        record.durationMs = Date.now() - started;

        const statusLabel = record.status === 'ok' ? '✓' : '✗';
        const flags = flagSummary(record);
        console.log(`  ${statusLabel} ${viewport.id.padEnd(13)} ${route.padEnd(12)} ${record.status.padEnd(14)} ${String(record.durationMs).padStart(5)}ms${flags ? '  ' + flags : ''}`);

        await page.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  await writeReports(outRoot, captured);

  const okCount = captured.filter((c) => c.status === 'ok').length;
  const totalFlags = captured.reduce((n, c) => n + countFlags(c), 0);
  console.log('');
  console.log(`[visual-snapshots] done — ${okCount}/${captured.length} captured ok · ${totalFlags} automated flag(s) across all rows`);
  console.log(`[visual-snapshots] html:   ${path.join(outRoot, 'report.html')}`);
  console.log(`[visual-snapshots] json:   ${path.join(outRoot, 'report.json')}`);
  console.log(`[visual-snapshots] md:     ${path.join(outRoot, 'report.md')}`);
}

// ── Per-record flag summary helpers ──────────────────────────────────────────

function countFlags(rec) {
  return (
    rec.consoleErrors.length +
    rec.pageErrors.length +
    rec.failedRequests.length +
    rec.brokenImages.length +
    rec.forbiddenMatches.length +
    (rec.overflow && rec.overflow.overflows ? 1 : 0)
  );
}

function flagSummary(rec) {
  const parts = [];
  if (rec.consoleErrors.length) parts.push(`err:${rec.consoleErrors.length}`);
  if (rec.pageErrors.length) parts.push(`pageerr:${rec.pageErrors.length}`);
  if (rec.failedRequests.length) parts.push(`netfail:${rec.failedRequests.length}`);
  if (rec.brokenImages.length) parts.push(`brokenimg:${rec.brokenImages.length}`);
  if (rec.overflow && rec.overflow.overflows) parts.push(`overflow:+${rec.overflow.scrollWidth - rec.overflow.innerWidth}px`);
  if (rec.forbiddenMatches.length) parts.push(`forbidden:${rec.forbiddenMatches.map((m) => m.name).join(',')}`);
  return parts.join(' ');
}

// ── Reports ───────────────────────────────────────────────────────────────────

async function writeReports(outRoot, captured) {
  // Group by route for the per-route sections.
  const byRoute = new Map();
  for (const rec of captured) {
    if (!byRoute.has(rec.route)) byRoute.set(rec.route, new Map());
    byRoute.get(rec.route).set(rec.viewport, rec);
  }

  // ── JSON ──
  const jsonPayload = {
    baseUrl: BASE_URL,
    capturedAt: new Date().toISOString(),
    forbiddenPatterns: FORBIDDEN_PATTERNS.map((p) => ({ name: p.name, source: p.source, flags: p.flags })),
    viewports: VIEWPORTS,
    routes: ALL_ROUTES,
    shots: captured,
    summary: ALL_ROUTES.map((route) => routeSummary(route, byRoute.get(route))),
  };
  await writeFile(path.join(outRoot, 'report.json'), JSON.stringify(jsonPayload, null, 2), 'utf8');

  // ── MD (compact, terminal-friendly) ──
  const mdLines = [];
  mdLines.push(`# HSB visual snapshots — ${path.basename(outRoot)}`);
  mdLines.push('');
  mdLines.push(`- Base URL: \`${BASE_URL}\``);
  mdLines.push(`- Captured at: ${new Date().toISOString()}`);
  mdLines.push(`- Shots: ${captured.length} (${ALL_ROUTES.length} routes × ${VIEWPORTS.length} viewports)`);
  mdLines.push(`- Automated flags: ${captured.reduce((n, c) => n + countFlags(c), 0)}`);
  mdLines.push('');
  mdLines.push('## Executive summary');
  mdLines.push('');
  mdLines.push('| Route | Desktop | Mobile | Tight-mobile | Console err | Broken img | Overflow | Forbidden |');
  mdLines.push('|---|---|---|---|---|---|---|---|');
  for (const route of ALL_ROUTES) {
    const s = routeSummary(route, byRoute.get(route));
    mdLines.push(`| \`${route}\` | ${s.byViewport.desktop || '—'} | ${s.byViewport.mobile || '—'} | ${s.byViewport['tight-mobile'] || '—'} | ${s.consoleErrors} | ${s.brokenImages} | ${s.overflowAny ? '⚠️' : '—'} | ${s.forbiddenNames.join(', ') || '—'} |`);
  }
  mdLines.push('');
  mdLines.push('## Per-route detail');
  for (const route of ALL_ROUTES) {
    const s = routeSummary(route, byRoute.get(route));
    mdLines.push('');
    mdLines.push(`### \`${route}\``);
    mdLines.push('');
    for (const v of VIEWPORTS) {
      const r = (byRoute.get(route) || new Map()).get(v.id);
      if (!r) continue;
      mdLines.push(`- ${v.id} (${v.width}×${v.height}): status=${r.status} http=${r.httpStatus ?? '—'} duration=${r.durationMs}ms — [${r.file}](./${r.file})`);
    }
    if (s.flagsList.length) {
      mdLines.push('');
      mdLines.push('Flags:');
      for (const f of s.flagsList) mdLines.push(`  - ${f}`);
    }
  }
  await writeFile(path.join(outRoot, 'report.md'), mdLines.join('\n'), 'utf8');

  // ── HTML ──
  const html = buildHtml(outRoot, byRoute);
  await writeFile(path.join(outRoot, 'report.html'), html, 'utf8');
}

function routeSummary(route, viewportMap) {
  const byViewport = {};
  let consoleErrors = 0;
  let pageErrors = 0;
  let brokenImages = 0;
  let failedRequests = 0;
  let overflowAny = false;
  const forbiddenNames = new Set();
  const flagsList = [];
  for (const v of VIEWPORTS) {
    const r = (viewportMap || new Map()).get(v.id);
    if (!r) { byViewport[v.id] = 'missing'; continue; }
    byViewport[v.id] = r.status;
    consoleErrors += r.consoleErrors.length;
    pageErrors += r.pageErrors.length;
    brokenImages += r.brokenImages.length;
    failedRequests += r.failedRequests.length;
    if (r.overflow && r.overflow.overflows) {
      overflowAny = true;
      flagsList.push(`${v.id}: horizontal overflow +${r.overflow.scrollWidth - r.overflow.innerWidth}px`);
    }
    for (const f of r.forbiddenMatches) forbiddenNames.add(f.name);
    for (const e of r.consoleErrors) flagsList.push(`${v.id}: console.error — ${e}`);
    for (const e of r.pageErrors) flagsList.push(`${v.id}: pageerror — ${e}`);
    for (const f of r.failedRequests) flagsList.push(`${v.id}: ${f.kind} ${f.resourceType} ${f.url}${f.detail ? ' — ' + f.detail : ''}`);
    for (const b of r.brokenImages) flagsList.push(`${v.id}: broken image — ${b}`);
    for (const f of r.forbiddenMatches) flagsList.push(`${v.id}: forbidden "${f.name}" ×${f.count}`);
  }
  return { route, byViewport, consoleErrors, pageErrors, brokenImages, failedRequests, overflowAny, forbiddenNames: Array.from(forbiddenNames), flagsList };
}

function pillClassForStatus(s) {
  if (s === 'ok') return 'pill ok';
  if (s === 'missing') return 'pill missing';
  return 'pill bad';
}

function buildHtml(outRoot, byRoute) {
  const html = [];
  html.push('<!doctype html>');
  html.push('<html lang="en"><head><meta charset="utf-8" />');
  html.push(`<title>HSB visual snapshots — ${escapeHtml(path.basename(outRoot))}</title>`);
  html.push('<style>');
  html.push(`
    :root {
      --cream: #f8f0dd; --paper: #fff8ec; --paper2: #f5ead2;
      --hairline: #d8c6a2; --ink: #1f1a16; --soft: #695f54;
      --rose: #a64c4c; --green: #4f7c4f; --amber: #b8860b;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: var(--cream); color: var(--ink); }
    .nav { position: sticky; top: 0; z-index: 50; background: var(--cream); border-bottom: 1px solid var(--hairline); padding: 10px 24px; overflow-x: auto; white-space: nowrap; }
    .nav a { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--soft); text-decoration: none; margin-right: 18px; }
    .nav a:hover { color: var(--rose); }
    .nav .brand { color: var(--ink); margin-right: 24px; }
    .container { padding: 24px; max-width: 1600px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 6px; }
    h2 { font-size: 20px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--hairline); }
    .meta { color: var(--soft); font-size: 13px; margin-bottom: 18px; }
    .summary-table { width: 100%; border-collapse: collapse; background: var(--paper); border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; }
    .summary-table th, .summary-table td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid var(--hairline); text-align: left; }
    .summary-table th { background: var(--paper2); font-weight: 700; }
    .summary-table tr:last-child td { border-bottom: 0; }
    .summary-table td.route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    .pill.ok { background: rgba(79,124,79,0.16); color: var(--green); }
    .pill.bad { background: rgba(166,76,76,0.16); color: var(--rose); }
    .pill.missing { background: rgba(105,95,84,0.18); color: var(--soft); }
    .pill.amber { background: rgba(184,134,11,0.18); color: var(--amber); }
    .checks { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
    .check { font-size: 12px; padding: 4px 10px; border-radius: 6px; background: var(--paper2); color: var(--ink); border: 1px solid var(--hairline); }
    .check.bad { background: rgba(166,76,76,0.12); color: var(--rose); border-color: rgba(166,76,76,0.4); }
    .check.ok  { background: rgba(79,124,79,0.10); color: var(--green); border-color: rgba(79,124,79,0.35); }
    .flag-list { margin: 6px 0 14px; padding-left: 18px; font-size: 12px; color: var(--rose); }
    .flag-list li { margin: 2px 0; }
    .qa { background: var(--paper); border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 16px; margin: 8px 0 14px; }
    .qa h4 { margin: 0 0 6px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); }
    .qa ul { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 20px; }
    .qa li { font-size: 13px; padding: 3px 0; break-inside: avoid; }
    .qa input[type=checkbox] { transform: translateY(2px); accent-color: var(--rose); margin-right: 6px; }
    .qa .review-status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: var(--soft); margin-top: 8px; }
    .shots { display: grid; gap: 12px; grid-template-columns: 2fr 1fr 1fr; align-items: start; }
    @media (max-width: 1100px) { .shots { grid-template-columns: 1fr; } }
    .shot { background: var(--paper); border: 1px solid var(--hairline); border-radius: 10px; padding: 10px; }
    .shot h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--rose); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .shot .dims { color: var(--soft); font-weight: 600; }
    .shot a.img-link { display: block; }
    .shot img { width: 100%; height: auto; display: block; border-radius: 6px; background: #fff; cursor: zoom-in; }
    .shot .meta { font-size: 11px; color: var(--soft); margin-top: 6px; }
    .footer { font-size: 12px; color: var(--soft); padding: 24px; text-align: center; }
  `);
  html.push('</style></head><body>');

  // Sticky nav
  html.push('<nav class="nav">');
  html.push(`<a class="brand" href="#top">HSB visual QA</a>`);
  html.push('<a href="#summary">Summary</a>');
  for (const route of ALL_ROUTES) {
    html.push(`<a href="#route-${escapeHtml(slugifyRoute(route))}">${escapeHtml(route)}</a>`);
  }
  html.push('<a href="./report.json">report.json</a>');
  html.push('<a href="./report.md">report.md</a>');
  html.push('</nav>');

  html.push('<div class="container" id="top">');
  html.push(`<h1>HSB visual snapshots — ${escapeHtml(path.basename(outRoot))}</h1>`);
  const totalFlags = Array.from(byRoute.values()).reduce((n, vm) => n + Array.from(vm.values()).reduce((nn, r) => nn + countFlags(r), 0), 0);
  html.push(`<div class="meta">Base URL: <code>${escapeHtml(BASE_URL)}</code> · Captured: ${escapeHtml(new Date().toISOString())} · ${ALL_ROUTES.length} routes × ${VIEWPORTS.length} viewports · <strong>${totalFlags}</strong> automated flag(s) total</div>`);

  // Executive summary
  html.push('<h2 id="summary">Executive summary</h2>');
  html.push('<table class="summary-table"><thead><tr>');
  html.push('<th>Route</th>');
  for (const v of VIEWPORTS) html.push(`<th>${escapeHtml(v.id)}</th>`);
  html.push('<th>Console errors</th><th>Broken images</th><th>Horizontal overflow</th><th>Forbidden strings</th><th>Human review</th>');
  html.push('</tr></thead><tbody>');
  for (const route of ALL_ROUTES) {
    const s = routeSummary(route, byRoute.get(route));
    html.push('<tr>');
    html.push(`<td class="route"><a href="#route-${escapeHtml(slugifyRoute(route))}">${escapeHtml(route)}</a></td>`);
    for (const v of VIEWPORTS) {
      const st = s.byViewport[v.id] || 'missing';
      html.push(`<td><span class="${pillClassForStatus(st === 'ok' ? 'ok' : st === 'missing' ? 'missing' : 'bad')}">${escapeHtml(st)}</span></td>`);
    }
    html.push(`<td>${s.consoleErrors > 0 ? `<span class="pill bad">${s.consoleErrors}</span>` : '<span class="pill ok">0</span>'}</td>`);
    html.push(`<td>${s.brokenImages > 0 ? `<span class="pill bad">${s.brokenImages}</span>` : '<span class="pill ok">0</span>'}</td>`);
    html.push(`<td>${s.overflowAny ? '<span class="pill bad">yes</span>' : '<span class="pill ok">no</span>'}</td>`);
    html.push(`<td>${s.forbiddenNames.length ? `<span class="pill bad">${escapeHtml(s.forbiddenNames.join(', '))}</span>` : '<span class="pill ok">none</span>'}</td>`);
    html.push(`<td><label><input type="checkbox"> reviewed</label></td>`);
    html.push('</tr>');
  }
  html.push('</tbody></table>');

  // Per-route detail
  for (const route of ALL_ROUTES) {
    const s = routeSummary(route, byRoute.get(route));
    html.push(`<h2 id="route-${escapeHtml(slugifyRoute(route))}"><code>${escapeHtml(route)}</code></h2>`);

    // Automated checks summary chips
    html.push('<div class="checks">');
    html.push(chipHtml(s.consoleErrors === 0, `Console errors: ${s.consoleErrors}`));
    html.push(chipHtml(s.pageErrors === 0, `Page errors: ${s.pageErrors}`));
    html.push(chipHtml(s.failedRequests === 0, `Failed requests: ${s.failedRequests}`));
    html.push(chipHtml(s.brokenImages === 0, `Broken images: ${s.brokenImages}`));
    html.push(chipHtml(!s.overflowAny, `Horizontal overflow: ${s.overflowAny ? 'yes' : 'no'}`));
    html.push(chipHtml(s.forbiddenNames.length === 0, `Forbidden strings: ${s.forbiddenNames.length ? s.forbiddenNames.join(', ') : 'none'}`));
    html.push('</div>');

    // Detailed flag list (only if any)
    if (s.flagsList.length) {
      html.push('<ul class="flag-list">');
      for (const f of s.flagsList) html.push(`<li>${escapeHtml(f)}</li>`);
      html.push('</ul>');
    }

    // Human QA checklist
    html.push('<div class="qa">');
    html.push(`<h4>Human QA checklist · ${escapeHtml(route)}</h4>`);
    html.push('<ul>');
    for (const item of HUMAN_CHECKLIST) {
      html.push(`<li><label><input type="checkbox"> ${escapeHtml(item)}</label></li>`);
    }
    html.push('</ul>');
    html.push('<div class="review-status">Human review status: <label><input type="checkbox"> reviewed by ___</label></div>');
    html.push('</div>');

    // Side-by-side screenshots
    html.push('<div class="shots">');
    for (const v of VIEWPORTS) {
      const r = (byRoute.get(route) || new Map()).get(v.id);
      const file = r ? r.file : `${slugifyRoute(route)}__${v.id}.png`;
      html.push('<div class="shot">');
      html.push(`<h3><span>${escapeHtml(v.id)}</span><span class="dims">${v.width}×${v.height} · ${r ? escapeHtml(`${r.status}${r.httpStatus ? ` (${r.httpStatus})` : ''}`) : 'missing'}</span></h3>`);
      html.push(`<a class="img-link" href="./${escapeHtml(file)}" target="_blank" rel="noopener"><img src="./${escapeHtml(file)}" alt="${escapeHtml(route)} ${escapeHtml(v.id)}" loading="lazy" /></a>`);
      html.push(`<div class="meta">${r ? `${r.durationMs}ms` : ''}${r && r.error ? ` · <strong style="color:var(--rose)">${escapeHtml(r.error)}</strong>` : ''}</div>`);
      html.push('</div>');
    }
    html.push('</div>');
  }

  html.push(`<div class="footer">HSB launch-QA harness · capture + automated checks + human checklist · static report, no telemetry</div>`);
  html.push('</div></body></html>');
  return html.join('\n');
}

function chipHtml(ok, text) {
  return `<span class="check ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${escapeHtml(text)}</span>`;
}

main().catch((err) => {
  console.error('[visual-snapshots] fatal:', err);
  process.exit(1);
});
