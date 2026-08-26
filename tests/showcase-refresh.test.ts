import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const source = readFileSync(join(root, 'src/components/editorial-site.tsx'), 'utf8');

const expectedAssets = [
  'dog-city/page-05.jpg',
  'dog-city/page-08.jpg',
  'dog-city/page-17.jpg',
  'dog-city/page-23.jpg',
  'pasta-planet/page-06.jpg',
  'pasta-planet/page-10.jpg',
  'pasta-planet/page-19.jpg',
  'pasta-planet/page-24.jpg',
] as const;

test('the approved eight-page showcase is complete and locally bundled', () => {
  for (const asset of expectedAssets) {
    const publicPath = `/assets/showcase/${asset}`;
    assert.match(source, new RegExp(publicPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(join(root, 'public', publicPath)), true, `${publicPath} must exist`);
  }
});

test('Dog City page 17 and Pasta Planet page 19 remain the homepage leads', () => {
  assert.match(source, /id: 'dog-city'[\s\S]*?leadPage: '17'/);
  assert.match(source, /id: 'pasta-planet'[\s\S]*?leadPage: '19'/);
});

test('Pasta Planet crops keep Lukas in frame', () => {
  for (const page of ['6', '10', '19', '24']) {
    assert.match(
      source,
      new RegExp(`page: '${page}'[^\\n]+pasta-planet[^\\n]+focalPoint: '(?:20|22)% 50%'`),
      `Pasta Planet page ${page} needs its Lukas-focused crop`,
    );
  }
  assert.equal((source.match(/style=\{\{ objectPosition: focalPoint\((?:lead|page)\) \}\}/g) ?? []).length, 3);
});

test('sample framing stays illustrative and proof-first', () => {
  assert.match(source, /Digital sample · illustrative only/);
  assert.match(source, /Each new paid book still gets its own proof and approval pass/);
  assert.match(source, /Every new paid book still receives its own proof and approval pass/);
});
