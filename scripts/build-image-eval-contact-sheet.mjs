#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(repoRoot, "..");

const DEFAULT_RUN = path.join(workspaceRoot, "artifacts", "hsb-family-photo-eval-2026-05-25");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function parseArgs(argv) {
  const args = {
    run: DEFAULT_RUN,
    fluxDir: null,
    gptDir: null,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") args.run = path.resolve(argv[++i]);
    else if (arg === "--flux-dir") args.fluxDir = path.resolve(argv[++i]);
    else if (arg === "--gpt-dir") args.gptDir = path.resolve(argv[++i]);
    else if (arg === "--out") args.out = path.resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.run = path.resolve(args.run);
  args.fluxDir ??= path.join(args.run, "outputs");
  args.gptDir ??= path.join(args.run, "gpt-exports");
  args.out ??= path.join(args.run, "contact-sheets", "gpt-vs-flux2-contact-sheet.html");
  return args;
}

function printHelp() {
  console.log(`Build a private HSB image-model eval contact sheet.

Usage:
  node scripts/build-image-eval-contact-sheet.mjs \\
    --run ../artifacts/hsb-family-photo-eval-2026-05-25

Optional:
  --flux-dir <dir>  Directory with FLUX outputs. Defaults to <run>/outputs.
  --gpt-dir <dir>   Directory with GPT exports. Defaults to <run>/gpt-exports.
  --out <file>      Output HTML path.

GPT export naming:
  Put exported GPT images in <run>/gpt-exports using scene slugs such as:
  01-bedtime-room.png, bedtime-room.png, family-reading-v2.png
`);
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function walkImages(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const absolute = path.join(current, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        stack.push(absolute);
      } else if (IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
        files.push(absolute);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function normalizeSlug(value) {
  return value
    .toLowerCase()
    .replace(/\.(jpg|jpeg|png|webp)$/i, "")
    .replace(/^\d{1,2}[-_]/, "")
    .replace(/[-_](gpt|chatgpt|openai|flux|flux2|variant|v)\d*$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function indexFluxImages(fluxDir) {
  const indexed = new Map();
  for (const imagePath of walkImages(fluxDir)) {
    const parentSlug = normalizeSlug(path.basename(path.dirname(imagePath)));
    const fileSlug = normalizeSlug(path.basename(imagePath));
    const slug = parentSlug || fileSlug;
    if (!indexed.has(slug)) indexed.set(slug, []);
    indexed.get(slug).push(imagePath);
  }
  return indexed;
}

function indexGptImages(gptDir) {
  const indexed = new Map();
  for (const imagePath of walkImages(gptDir)) {
    const slug = normalizeSlug(path.basename(imagePath));
    if (!indexed.has(slug)) indexed.set(slug, []);
    indexed.get(slug).push(imagePath);
  }
  return indexed;
}

function imageSrc(imagePath, outPath) {
  return encodeURI(path.relative(path.dirname(outPath), imagePath));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreBox(label) {
  return `<label><span>${escapeHtml(label)}</span><b>1</b><i></i><b>5</b></label>`;
}

function renderImages(images, outPath, providerName) {
  if (!images || images.length === 0) {
    return `<div class="empty">No ${escapeHtml(providerName)} image found yet. Add exports and rebuild.</div>`;
  }

  return images
    .map((imagePath) => {
      const src = imageSrc(imagePath, outPath);
      const filename = path.basename(imagePath);
      return `<figure>
        <img src="${src}" alt="${escapeHtml(providerName)} output ${escapeHtml(filename)}">
        <figcaption>${escapeHtml(filename)}</figcaption>
      </figure>`;
    })
    .join("");
}

function promptForScene(runDir, scene, index) {
  const promptPath = path.join(runDir, "prompts", `${String(index + 1).padStart(2, "0")}-${scene.id}.txt`);
  if (!existsSync(promptPath)) return scene.prompt || "";
  return readFileSync(promptPath, "utf8").trim();
}

function renderScene(scene, index, runDir, fluxImages, gptImages, outPath) {
  const prompt = promptForScene(runDir, scene, index);
  const slug = normalizeSlug(scene.id);
  const flux = fluxImages.get(slug) || [];
  const gpt = gptImages.get(slug) || [];

  return `<section class="scene">
    <header>
      <div>
        <p class="eyebrow">Scene ${index + 1}</p>
        <h2>${escapeHtml(scene.id)}</h2>
      </div>
      <div class="score">
        ${scoreBox("Child likeness")}
        ${scoreBox("Watercolor / book feel")}
        ${scoreBox("Family + dog realism")}
        ${scoreBox("Text artifacts avoided")}
        ${scoreBox("Gift-quality confidence")}
      </div>
    </header>

    <details>
      <summary>Prompt</summary>
      <pre>${escapeHtml(prompt)}</pre>
    </details>

    <div class="comparison">
      <article>
        <h3>GPT subscription export</h3>
        ${renderImages(gpt, outPath, "GPT")}
      </article>
      <article>
        <h3>FLUX.2 / fal output</h3>
        ${renderImages(flux, outPath, "FLUX.2")}
      </article>
    </div>

    <div class="notes">
      <strong>Reviewer notes</strong>
      <div class="note-lines"></div>
      <div class="note-lines short"></div>
    </div>
  </section>`;
}

function buildHtml({ run, fluxDir, gptDir, out }) {
  const manifest = readJson(path.join(run, "manifest.json"), {
    date: new Date().toISOString().slice(0, 10),
    model: "unknown",
    scenes: [],
  });
  const scenes = manifest.scenes || [];
  const fluxImages = indexFluxImages(fluxDir);
  const gptImages = indexGptImages(gptDir);
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HSB GPT vs FLUX.2 Image Eval</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #211c18;
      --muted: #6c6258;
      --line: #ddd2c4;
      --paper: #fffaf1;
      --panel: #ffffff;
      --accent: #1f6f64;
      --warn: #9d4d20;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .intro {
      display: grid;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
      margin-bottom: 22px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(28px, 4vw, 44px); line-height: 1.05; letter-spacing: 0; }
    h2 { font-size: 24px; letter-spacing: 0; }
    h3 { font-size: 16px; letter-spacing: 0; }
    .meta, .rubric, .empty, figcaption, .eyebrow { color: var(--muted); }
    .rubric {
      display: grid;
      gap: 6px;
      max-width: 900px;
    }
    .scene {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin: 18px 0;
      padding: 18px;
      break-inside: avoid;
    }
    .scene header {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(320px, 520px);
      gap: 18px;
      align-items: start;
    }
    .eyebrow {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .score {
      display: grid;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fffdf9;
    }
    .score label {
      display: grid;
      grid-template-columns: 1fr auto 96px auto;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
    }
    .score i {
      display: block;
      height: 1px;
      background: repeating-linear-gradient(90deg, var(--line), var(--line) 10px, transparent 10px, transparent 16px);
    }
    details {
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      margin: 16px 0;
      padding: 10px 0;
    }
    summary { cursor: pointer; font-weight: 700; color: var(--accent); }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 12px 0 0;
      color: var(--muted);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .comparison {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    article {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-width: 0;
      background: #fffefa;
    }
    article h3 { margin-bottom: 10px; }
    figure { margin: 0 0 12px; }
    img {
      display: block;
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      background: #f4eee5;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    figcaption {
      margin-top: 6px;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .empty {
      display: grid;
      place-items: center;
      min-height: 180px;
      border: 1px dashed var(--line);
      border-radius: 6px;
      padding: 16px;
      text-align: center;
      background: #faf4ea;
    }
    .notes {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fffdf9;
    }
    .note-lines {
      height: 62px;
      margin-top: 8px;
      background: repeating-linear-gradient(#fffdf9 0, #fffdf9 23px, var(--line) 24px);
    }
    .note-lines.short { height: 34px; }
    .privacy {
      border-left: 4px solid var(--warn);
      padding-left: 12px;
      color: var(--muted);
    }
    @media (max-width: 820px) {
      .scene header, .comparison { grid-template-columns: 1fr; }
      main { width: min(100vw - 20px, 1180px); padding-top: 18px; }
    }
    @media print {
      body { background: #fff; }
      main { width: 100%; padding: 0; }
      .scene { page-break-inside: avoid; }
      details[open] pre, summary { display: none; }
    }
  </style>
</head>
<body>
  <main>
    <section class="intro">
      <p class="eyebrow">Private HSB Eval</p>
      <h1>GPT vs FLUX.2 Image Contact Sheet</h1>
      <p class="meta">Generated ${escapeHtml(generatedAt)} from ${escapeHtml(path.basename(run))}. FLUX source: ${escapeHtml(path.relative(run, fluxDir) || ".")}. GPT source: ${escapeHtml(path.relative(run, gptDir) || ".")}.</p>
      <p class="privacy">Private family-reference material may be represented here. Keep this artifact local; do not commit generated sheets, source photos, or child likeness outputs to the public app tree.</p>
      <div class="rubric">
        <strong>Decision rubric</strong>
        <span>Prefer the provider that gives recognizable child likeness, true watercolor book texture, believable family/dog figures, no fake text, and repeatable gift-quality output. A beautiful single image is not enough unless the provider can repeat the child identity across scenes.</span>
      </div>
    </section>
    ${scenes.map((scene, index) => renderScene(scene, index, run, fluxImages, gptImages, out)).join("\n")}
  </main>
</body>
</html>`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.run)) {
    throw new Error(`Eval run not found: ${args.run}`);
  }
  mkdirSync(path.dirname(args.out), { recursive: true });
  const html = buildHtml(args);
  writeFileSync(args.out, html, "utf8");
  console.log(args.out);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
