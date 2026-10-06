import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const source = readFileSync(join(root, 'src/components/editorial-site.tsx'), 'utf8');
const metadata = readFileSync(join(root, 'src/app/samples/page.tsx'), 'utf8');

test('real-book photos identify the printed formats accurately', () => {
  assert.match(source, /title: 'Lukas, King of the Dinosaurs',\s*edition: 'Softcover'/);
  assert.match(source, /title: 'Lukas and the Biggest Day Ever',\s*edition: 'Softcover'/);
  assert.match(source, /title: 'Lukas and the Pasta Planet',\s*edition: 'Hardcover'/);
  assert.doesNotMatch(source, /dinosaur hardcover|dino hardcover|Printed hardcover photos/i);
  assert.doesNotMatch(source, /hsb-lukas-dino-photo-cover\.jpg/);
});

test('every displayed physical-book photo is bundled', () => {
  const paths = [
    'hsb-lukas-dino-photo-hands-1.jpg',
    'hsb-lukas-dino-photo-feast.jpg',
    'physical-books/biggest-day-softcover-cover.jpg',
    'physical-books/biggest-day-softcover-bowling.jpg',
    'physical-books/pasta-planet-hardcover-bridge.jpg',
    'physical-books/pasta-planet-hardcover-space.jpg',
  ];
  for (const path of paths) {
    assert.match(source, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(join(root, 'public/assets', path)), true, path);
  }
});

test('the samples page describes both printed editions', () => {
  assert.match(source, /Softcover and hardcover, in hand/);
  assert.match(metadata, /real printed softcover and hardcover books/);
});
