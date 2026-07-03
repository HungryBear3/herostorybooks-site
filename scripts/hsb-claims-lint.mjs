export const HSB_CLAIM_RULES = [
  { id: 'instant_claim', pattern: /\binstant(?:ly)?\b/i, message: 'Avoid instant/automated speed promises.' },
  { id: 'same_day_claim', pattern: /\bsame[- ]day\b/i, message: 'Avoid same-day delivery/proof promises.' },
  { id: 'two_business_days', pattern: /\b(?:within\s+)?2\s+business\s+days\b/i, message: 'Avoid 2-business-day proof promises until ops SLA is proven.' },
  { id: 'guaranteed_delivery', pattern: /\bguaranteed\s+(?:holiday\s+)?delivery\b/i, message: 'Avoid guaranteed delivery claims.' },
  { id: 'automatic_deletion', pattern: /\bautomatic(?:ally)?\s+delet(?:e|ion|ed)\b/i, message: 'Avoid automatic deletion claims unless deletion is implemented.' },
  { id: 'fake_testimonial', pattern: /\b(?:testimonial|review)\b.*\b(?:fake|placeholder|lorem)\b/i, message: 'Do not use fake/customer-looking testimonials.' },
];

export function lintHsbClaims(text) {
  const violations = [];
  for (const rule of HSB_CLAIM_RULES) {
    if (rule.pattern.test(text)) {
      violations.push({ id: rule.id, message: rule.message });
    }
  }
  return { ok: violations.length === 0, violations };
}

async function main() {
  const fs = await import('node:fs/promises');
  const inputs = process.argv.slice(2);
  const text = inputs.length ? (await Promise.all(inputs.map((file) => fs.readFile(file, 'utf8')))).join('\n') : await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  const result = lintHsbClaims(String(text));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
