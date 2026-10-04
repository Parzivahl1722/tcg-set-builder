import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createCache } from '../server/cache.js';
import { createStore } from '../server/store.js';

let dir, server, base, calls;
let failFetch = false;

const fake = {
  id: 'pokemon',
  name: 'Pokémon',
  async fetchSets() {
    calls.sets++;
    if (failFetch) throw new Error('API down');
    return [{ id: 'sv1', name: 'Scarlet & Violet', series: 'Scarlet & Violet', releaseDate: '2023-03-31', total: 3 }];
  },
  async fetchCards(setId) {
    calls.cards++;
    if (failFetch) throw new Error('API down');
    assert.equal(setId, 'sv1');
    return [
      { id: 'sv1-10', number: '10', name: 'Ten', rarity: 'Common', image: null, imageLarge: null, variants: ['Normal', 'Reverse Holo'] },
      { id: 'sv1-2', number: '2', name: 'Two', rarity: 'Common', image: null, imageLarge: null, variants: ['Normal', 'Reverse Holo'] },
      { id: 'sv1-200', number: '200', name: 'Big', rarity: 'Special Illustration Rare', image: null, imageLarge: null, variants: ['Holo'] },
    ];
  },
};

const json = async (url, opts = {}) => {
  const res = await fetch(base + url, { ...opts, headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  calls = { sets: 0, cards: 0 };
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-'));
  const store = await createStore(path.join(dir, 'collection.json'));
  const app = createApp({ sources: { pokemon: fake }, cache: createCache(path.join(dir, 'cache')), store });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('unknown game and set return 404', async () => {
  assert.equal((await json('/api/games/mtg/sets')).status, 404);
  assert.equal((await json('/api/games/pokemon/sets/nope')).status, 404);
});

test('set loads sorted by number with resolved variants', async () => {
  const { status, body } = await json('/api/games/pokemon/sets/sv1');
  assert.equal(status, 200);
  assert.deepEqual(body.cards.map((c) => c.number), ['2', '10', '200']);
  assert.deepEqual(body.progress, { cards: 3, cardsOwned: 0, variants: 5, variantsOwned: 0, copies: 0, value: 0, paid: 0 });
});

test('owning a card persists to disk and shows in progress', async () => {
  const put = await json('/api/games/pokemon/cards/sv1-2', {
    method: 'PUT',
    body: JSON.stringify({ variants: { 'Reverse Holo': [{ id: 'c1', grader: 'PSA', grade: '10', value: 50 }] } }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.variants['Reverse Holo'][0].grader, 'PSA');

  const saved = JSON.parse(await fs.readFile(path.join(dir, 'collection.json'), 'utf8'));
  assert.equal(saved.cards['pokemon:sv1-2'].variants['Reverse Holo'][0].grade, '10');

  const { body } = await json('/api/games/pokemon/sets/sv1');
  assert.equal(body.progress.cardsOwned, 1);
  assert.equal(body.progress.variantsOwned, 1);
  assert.equal(body.progress.value, 50);

  const sets = await json('/api/games/pokemon/sets');
  assert.equal(sets.body[0].progress.variantsOwned, 1);
});

test('clearing an entry removes it from the file', async () => {
  await json('/api/games/pokemon/cards/sv1-10', { method: 'PUT', body: JSON.stringify({ variants: { Normal: [{}] } }) });
  await json('/api/games/pokemon/cards/sv1-10', { method: 'PUT', body: JSON.stringify({ variants: {} }) });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'collection.json'), 'utf8'));
  assert.equal(saved.cards['pokemon:sv1-10'], undefined);
});

test('set rules add variants to matching rarities', async () => {
  const put = await json('/api/games/pokemon/sets/sv1/rules', {
    method: 'PUT',
    body: JSON.stringify([{ name: 'Poké Ball Reverse', rarities: ['Common'] }, { name: '' }]),
  });
  assert.deepEqual(put.body, [{ name: 'Poké Ball Reverse', rarities: ['Common'] }]);
  const { body } = await json('/api/games/pokemon/sets/sv1');
  assert.deepEqual(body.cards[0].variants, ['Normal', 'Reverse Holo', 'Poké Ball Reverse']);
  assert.deepEqual(body.cards[2].variants, ['Holo']);
  assert.equal(body.progress.variants, 7);
});

test('card data is cached and served stale when the API fails', async () => {
  const before = { ...calls };
  await json('/api/games/pokemon/sets/sv1');
  assert.equal(calls.cards, before.cards, 'second load should hit the cache');

  failFetch = true;
  const { status, body } = await json('/api/games/pokemon/sets/sv1?refresh=1');
  failFetch = false;
  assert.equal(status, 200);
  assert.equal(body.cards.length, 3);
});

test('export returns the collection file', async () => {
  const { body } = await json('/api/export');
  assert.ok(body.cards['pokemon:sv1-2']);
  assert.ok(body.setRules['pokemon:sv1']);
});

test('shared collection module is served to the browser', async () => {
  const res = await fetch(`${base}/lib/collection.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /export function resolveVariants/);
});
