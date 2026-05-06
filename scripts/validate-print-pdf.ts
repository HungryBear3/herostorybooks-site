import { execFileSync } from 'node:child_process';

const LIGATURE_DROPOUT_PATTERNS = [
  /\bfnger\b/i,
  /\bfrst\b/i,
  /\bdiferent\b/i,
  /\bfnal\b/i,
  /\bfnds\b/i,
  /\bfrefly\b/i,
  /\bfirefies\b/i,
  /\bpatern\b/i,
  /\brefecting\b/i,
  /\bratle\b/i,
  /\bsetle\b/i,
  /ord_f5dcfc8a0b84d06/i,
];

function extractPdfText(path: string): string {
  return execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
}

function validatePdf(path: string) {
  const output = execFileSync('pdffonts', [path], { encoding: 'utf8' });
  const rows = output
    .trim()
    .split('\n')
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cols = line.split(/\s{2,}/);
      const flags = (cols[3] ?? '').trim().split(/\s+/);
      return {
        name: cols[0] ?? 'unknown',
        embedded: flags[0] === 'yes',
        subset: flags[1] === 'yes',
      };
    });

  if (rows.length === 0) {
    throw new Error(`${path}: pdffonts reported no fonts`);
  }

  const unembedded = rows.filter((row) => !row.embedded);
  if (unembedded.length > 0) {
    const summary = unembedded.map((row) => `${row.name} embedded=${row.embedded} subset=${row.subset}`).join('; ');
    throw new Error(`${path}: unembedded fonts detected: ${summary}`);
  }

  const text = extractPdfText(path);
  const ligatureHit = LIGATURE_DROPOUT_PATTERNS.find((pattern) => pattern.test(text));
  if (ligatureHit) {
    throw new Error(`${path}: suspicious ligature-dropout text detected (${ligatureHit})`);
  }

  console.log(`${path}: OK (${rows.length} embedded font${rows.length === 1 ? '' : 's'})`);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: node --experimental-strip-types scripts/validate-print-pdf.ts <pdf-path> [more.pdf ...]');
  process.exit(2);
}

for (const path of paths) {
  validatePdf(path);
}
