import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createCache } from '../server/cache.js';
import { createStore } from '../server/store.js';
import { adjustCard } from '../server/sources/pokemon.js';

let dir, server, base;

// Cards are cached the way they were before the fix: Reverse Holo baked into every common.
const stale = [
  { id: 'me55-1', number: '1', name: 'One', rarity: 'Common', variants: ['Normal', 'Reverse Holo'] },
  { id: 'me55-2', number: '2', name: 'Two', rarity: 'Rare', variants: ['Normal', 'Reverse Holo'] },
  { id: 'me55-3', number: '3', name: 'Three', rarity: 'Double Rare', variants: ['Holo'] },
];
const source = {
  id: 'pokemon', name: 'Pokémon', adjustCard,
  fetchSets: async () => [{ id: 'me55', name: '30th Celebration', total: 3 }],
  fetchCards: async () => { throw new Error('should be served from cache'); },
};

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-adjust-'));
  await fs.mkdir(path.join(dir, 'cache'), { recursive: true });
  await fs.writeFile(path.join(dir, 'cache', 'pokemon-set-me55.json'), JSON.stringify({ fetchedAt: Date.now(), data: stale }));
  const store = await createStore(path.join(dir, 'collection.json'));
  const app = createApp({ sources: { pokemon: source }, cache: createCache(path.join(dir, 'cache')), store });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('cached cards lose Reverse Holo without a refresh, and the master set total shrinks', async () => {
  const res = await (await fetch(`${base}/api/games/pokemon/sets/me55`)).json();
  assert.deepEqual(res.cards.map((c) => c.variants), [['Normal'], ['Normal'], ['Holo']]);
  assert.equal(res.progress.variants, 3);
});

test('the set list shows the same corrected master set total', async () => {
  const list = await (await fetch(`${base}/api/games/pokemon/sets`)).json();
  assert.equal(list.find((s) => s.id === 'me55').progress.variants, 3);
});
