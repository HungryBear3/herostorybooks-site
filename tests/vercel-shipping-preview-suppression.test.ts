import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const OLD = 'rex/hsb-safeoff-20261019-jrm7sg1b';
const SHIPPING = 'rex/hsb-expedited-shipping-20261109';
const PREDECESSOR_SHA256 = 'db0809f249a737730781686a7ae4e9faf973323c0bfab9af920ff6d216934332';
const oldRow = `      "${OLD}": false`;
const newRow = `      "${SHIPPING}": false`;
const approvedRows = `${oldRow},\n${newRow}`;
const actual = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');

// Exact inverse protects the entire JSON text, not JSON.parse's last-key view.
// No whitespace normalization: duplicate keys, relocation and reordering fail.
function requireApprovedSuppression(source: string): void {
  const config = JSON.parse(source);
  assert.deepEqual(config.git, { deploymentEnabled: { [OLD]: false, [SHIPPING]: false } });
  assert.equal(source.split(approvedRows).length - 1, 1, 'exact approved rows occur once');
  const predecessor = source.replace(approvedRows, () => oldRow);
  assert.equal(createHash('sha256').update(predecessor).digest('hex'), PREDECESSOR_SHA256,
    'inverse must reconstruct every predecessor config byte');
}

test('actual root config suppresses only the exact shipping and preserved safeoff branches', () => {
  requireApprovedSuppression(actual);
  const map = JSON.parse(actual).git.deploymentEnabled;
  for (const branch of ['main', 'master', 'unrelated', `${SHIPPING}-other`, `${SHIPPING}/child`, SHIPPING.slice(0, -1)]) {
    assert.equal(Object.hasOwn(map, branch), false, `${branch} remains unspecified (Vercel defaults true)`);
  }
});

// Positive canonical control remains available during predecessor RED.
const canonical = actual.includes(approvedRows) ? actual : actual.replace(oldRow, approvedRows);
const gitBlock = `  "git": {\n    "deploymentEnabled": {\n${approvedRows}\n    }\n  },\n`;
const variants: Array<[string, string]> = [
  ['missing shipping', canonical.replace(approvedRows, oldRow)],
  ['missing old', canonical.replace(approvedRows, newRow)],
  ['wrong shipping', canonical.replace(SHIPPING, 'rex/hsb-wrong-20261109')],
  ['similar prefix', canonical.replace(SHIPPING, `${SHIPPING}-other`)],
  ['shipping wildcard', canonical.replace(SHIPPING, 'rex/hsb-expedited-shipping-*')],
  ['old substitution', canonical.replace(OLD, 'other')],
  ['shipping true', canonical.replace(newRow, newRow.replace('false', 'true'))],
  ['old true', canonical.replace(oldRow, oldRow.replace('false', 'true'))],
  ['extra main', canonical.replace(newRow, `${newRow},\n      "main": false`)],
  ['extra unrelated', canonical.replace(newRow, `${newRow},\n      "other": false`)],
  ['global false', canonical.replace(gitBlock, '  "git": { "deploymentEnabled": false },\n')],
  ['git false', canonical.replace(gitBlock, '  "git": false,\n')],
  ['duplicate shipping', canonical.replace(newRow, `${newRow},\n${newRow}`)],
  ['duplicate old', canonical.replace(oldRow, `${oldRow},\n${oldRow}`)],
  ['duplicate git', canonical.replace(gitBlock, gitBlock + gitBlock)],
  ['duplicate deploymentEnabled', canonical.replace('"deploymentEnabled": {', '"deploymentEnabled": false, "deploymentEnabled": {')],
  ['duplicate unrelated key', canonical.replace('"source": "/",', '"source": "/", "source": "/",')],
  ['reordered branches', canonical.replace(approvedRows, `${newRow},\n${oldRow}`)],
  ['relocated git', canonical.replace(gitBlock, '').replace('          "type": "host",', gitBlock + '          "type": "host",')],
  ['redirect drift', canonical.replace('utm_source=fleccas', 'utm_source=other')],
  ['cron drift', canonical.replace('*/10 * * * *', '*/11 * * * *')],
  ['unrelated setting', canonical.replace('{\n', '{\n  "version": 2,\n')],
];
for (const [label, changed] of variants) {
  test(`exact config oracle rejects ${label}`, () => {
    requireApprovedSuppression(canonical);
    assert.notEqual(changed, canonical, 'negative control must change bytes');
    assert.throws(() => requireApprovedSuppression(changed), { code: 'ERR_ASSERTION' });
  });
}
