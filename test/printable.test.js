import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { createCache } from '../server/cache.js';
import { createStore } from '../server/store.js';
import { toGrayscaleJpeg } from '../server/printable.js';

let dir, server, base, fetched;
const N = 11; // two pages: 9 + 2

const source = {
  id: 'pokemon',
  name: 'Pokémon',
  fetchSets: async () => [{ id: 's1', name: 'My Set: 30th!', total: N }],
  fetchCards: async () =>
    Array.from({ length: N }, (_, i) => ({
      id: `s1-${i + 1}`, number: String(i + 1), name: `Card ${i + 1}`, rarity: 'Common',
      image: null, imageLarge: i === 4 ? 'http://img.test/broken' : `http://img.test/${i + 1}`, variants: ['Normal'],
    })),
};

// A saturated red image with a transparent corner pixel.
const redPng = () =>
  sharp({ create: { width: 100, height: 140, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();

const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

before(async () => {
  fetched = [];
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-print-'));
  const store = await createStore(path.join(dir, 'collection.json'));
  const fetchImage = async (url) => {
    fetched.push(url);
    if (url.endsWith('/broken')) throw new Error('404');
    return redPng();
  };
  const app = createApp({
    sources: { pokemon: source },
    cache: createCache(path.join(dir, 'cache')),
    store,
    printable: { cacheDir: path.join(dir, 'cache', 'printable'), fetchImage },
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('toGrayscaleJpeg removes all color', async () => {
  const { data, info } = await sharp(await toGrayscaleJpeg(await redPng())).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    assert.ok(Math.abs(data[i] - data[i + 1]) <= 2 && Math.abs(data[i + 1] - data[i + 2]) <= 2);
  }
});

test('printable.pdf is a 3x3 PDF download and flags cards without an image', async () => {
  const res = await fetch(`${base}/api/games/pokemon/sets/s1/printable.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="My_Set_30th_?_printable\.pdf"/);
  assert.equal(res.headers.get('x-missing-images'), '1');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(buf), 2);
});

test('grayscale images are cached on disk; only the failed card is retried', async () => {
  fetched.length = 0;
  const res = await fetch(`${base}/api/games/pokemon/sets/s1/printable.pdf`);
  await res.arrayBuffer();
  assert.deepEqual(fetched, ['http://img.test/broken']);
});

test('printable.pdf 404s for an unknown set', async () => {
  const res = await fetch(`${base}/api/games/pokemon/sets/nope/printable.pdf`);
  assert.equal(res.status, 404);
});
