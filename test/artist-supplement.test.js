import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createCache } from '../server/cache.js';
import { createStore } from '../server/store.js';

let dir, server, base, store, supplementDown = false, supplementCalls = 0;

const card = (id, n, set, extra = {}) => ({ id, number: String(n), name: `Card ${n}`, rarity: 'Common', artist: 'A. Artist', image: null, imageLarge: null, variants: ['Normal'], setId: set, setName: set.toUpperCase(), releaseDate: '2024-01-01', ...extra });

const fake = {
  id: 'pokemon',
  name: 'Pokémon',
  async fetchSets() { return [{ id: 's1', name: 'S1', releaseDate: '2024-01-01' }]; },
  async fetchCards() { return []; },
  async fetchCardsByArtist() { return [card('s1-1', 1, 's1')]; },
  async fetchSupplementCardsByArtist() {
    supplementCalls++;
    if (supplementDown) throw new Error('TCGdex is down');
    return { cards: [card('s1-1', 1, 's1'), card('s1-2', 2, 's1', { artist: 'A. Artist' }), card('s1-3', 3, 's1')], skipped: 2 };
  },
};

const json = async (url) => { const r = await fetch(base + url); return { status: r.status, body: await r.json() }; };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-sup-'));
  store = await createStore(path.join(dir, 'collection.json'));
  const app = createApp({ sources: { pokemon: fake }, cache: createCache(path.join(dir, 'cache')), store });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a second database fills in cards the first lacks, without duplicating shared ones', async () => {
  supplementDown = true;
  const down = await json('/api/games/pokemon/artists/A.%20Artist');
  assert.deepEqual(down.body.cards.map((c) => c.id), ['s1-1'], 'the main database still answers when TCGdex is down');
  assert.match(down.body.notices.join(' '), /TCGdex couldn’t be reached \(TCGdex is down\)/);

  supplementDown = false;
  const ok = await json('/api/games/pokemon/artists/A.%20Artist');
  assert.deepEqual(ok.body.cards.map((c) => c.id).sort(), ['s1-1', 's1-2', 's1-3'], 'a failed lookup was not cached');
  assert.equal(ok.body.summary.cards, 3);
  assert.match(ok.body.notices.join(' '), /2 card\(s\) credited to this artist by TCGdex are in sets this app doesn’t list/);

  const before = supplementCalls;
  await json('/api/games/pokemon/artists/A.%20Artist');
  assert.equal(supplementCalls, before, 'a successful lookup is cached');
});

test('ownership works on cards that only the second database knows', async () => {
  await store.putEntry('pokemon', 's1-3', { variants: { Normal: [{}] } });
  const { body } = await json('/api/games/pokemon/artists/A.%20Artist');
  assert.deepEqual(body.cards.filter((c) => c.owned).map((c) => c.id), ['s1-3']);
  assert.equal(body.summary.cardsOwned, 1);
});

test('a hand assignment still beats the second database', async () => {
  await store.putArtists('pokemon', ['s1-2'], 'Someone Else');
  const { body } = await json('/api/games/pokemon/artists/A.%20Artist');
  assert.ok(!body.cards.some((c) => c.id === 's1-2'));
});
