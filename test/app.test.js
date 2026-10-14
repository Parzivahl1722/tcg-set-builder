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

fake.fetchCardsByArtist = async (name) => {
  calls.artist = (calls.artist ?? 0) + 1;
  assert.equal(name, 'Yuka Morii');
  return [
    { id: 'sv1-2', number: '2', name: 'Two', rarity: 'Common', artist: 'Yuka Morii', setId: 'sv1', setName: 'Scarlet & Violet', releaseDate: '2023-03-31' },
    { id: 'sv1-3', number: '3', name: 'Three', rarity: 'Common', artist: 'Yuka Morii', setId: 'sv1', setName: 'Scarlet & Violet', releaseDate: '2023-03-31' },
    { id: 'old-1', number: '1', name: 'Old', rarity: 'Rare', artist: 'Yuka Morii', setId: 'old', setName: 'Old Set', releaseDate: '2010-01-01' },
  ];
};

fake.searchCards = async (q) => {
  assert.equal(q, 'libre');
  return [{ id: 'xy-1', number: '1', name: 'Pikachu Libre', rarity: 'Rare', image: 'http://insecure.test/a.png', variants: ['Holo'], setId: 'xy', setName: 'XY', releaseDate: '2014-02-05', dex: [] }];
};

fake.fetchCardsBySpecies = async (name, opts = {}) => {
  calls.species = (calls.species ?? 0) + 1;
  calls.speciesOpts = opts;
  assert.equal(name, 'Pikachu');
  const card = (id, number, setId, setName, releaseDate, dex, extra = {}) =>
    ({ id, number, name: 'Pikachu', rarity: 'Common', image: null, imageLarge: null, variants: ['Normal', 'Reverse Holo'], setId, setName, releaseDate, dex, ...extra });
  return [
    card('sv1-2', '2', 'sv1', 'Scarlet & Violet', '2023-03-31', [25]),
    card('nodex-1', '5', 'zz', 'Odd Set', '2015-01-01', [], { name: 'Pikachu Libre', variants: ['Normal'] }),
    card('old-1', '1', 'old', 'Old Set', '2010-01-01', [25], { variants: ['Normal'] }),
  ];
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

test('artist page reports share of that artist\'s cards you own', async () => {
  // sv1-2 is owned (from an earlier test); sv1-3 and old-1 are not.
  const { status, body } = await json('/api/games/pokemon/artists/Yuka%20Morii');
  assert.equal(status, 200);
  assert.deepEqual(body.summary, { cards: 3, cardsOwned: 1, copies: 1, value: 50, paid: 0 });
  assert.deepEqual(body.cards.map((c) => [c.id, c.owned]), [['sv1-2', true], ['sv1-3', false], ['old-1', false]]);

  await json('/api/games/pokemon/artists/Yuka%20Morii');
  assert.equal(calls.artist, 1, 'second lookup should hit the cache');
});

test('a card with only hidden/custom variants and no copies is not counted as owned', async () => {
  await json('/api/games/pokemon/cards/sv1-3', { method: 'PUT', body: JSON.stringify({ hiddenVariants: ['Normal'] }) });
  const { body } = await json('/api/games/pokemon/artists/Yuka%20Morii');
  assert.equal(body.summary.cardsOwned, 1);
});

test('artist list covers owned cards in opened sets', async () => {
  const { body } = await json('/api/games/pokemon/artists');
  // The fake set data has no artist field, so those owned cards show up as stale, not as an artist.
  assert.deepEqual(body.artists, []);
  assert.deepEqual(body.staleSets, ['Scarlet & Violet']);
  assert.equal(body.ownedCards, 1);
});

test('games without artist data return 404; blank artist is rejected', async () => {
  assert.equal((await json('/api/games/pokemon/artists/%20')).status, 400);
  assert.equal((await json('/api/games/mtg/artists')).status, 404);
});

test('artist list groups owned cards by artist once set data includes it', async () => {
  const file = path.join(dir, 'cache', 'pokemon-set-sv1.json');
  const cached = JSON.parse(await fs.readFile(file, 'utf8'));
  cached.data.forEach((c) => { c.artist = c.id === 'sv1-2' ? 'Yuka  Morii' : 'Other'; });
  await fs.writeFile(file, JSON.stringify(cached));
  await json('/api/games/pokemon/cards/sv1-200', { method: 'PUT', body: JSON.stringify({ variants: { Holo: [{}] } }) });
  await json('/api/games/pokemon/cards/sv1-10', { method: 'PUT', body: JSON.stringify({ variants: { Normal: [{}] } }) });

  const { body } = await json('/api/games/pokemon/artists');
  assert.deepEqual(body.artists, [{ name: 'Other', owned: 2 }, { name: 'Yuka  Morii', owned: 1 }]);
  assert.deepEqual([body.staleSets, body.notInOpenedSets, body.noArtist], [[], 0, 0]);
});

test('species page lists one slot per variant, oldest first, with no-dex cards last', async () => {
  const { status, body } = await json('/api/games/pokemon/species/Pikachu');
  assert.equal(status, 200);
  // sv1 has the "Poké Ball Reverse" rule from an earlier test, and sv1-2 owns a Reverse Holo copy.
  assert.deepEqual(body.slots.map((sl) => [sl.cardId, sl.variant, sl.noDex]), [
    ['old-1', 'Normal', false],
    ['sv1-2', 'Normal', false],
    ['sv1-2', 'Reverse Holo', false],
    ['sv1-2', 'Poké Ball Reverse', false],
    ['nodex-1', 'Normal', true],
  ]);
  assert.equal(body.entries['sv1-2'].variants['Reverse Holo'].length, 1);
  await json('/api/games/pokemon/species/Pikachu');
  assert.equal(calls.species, 1, 'second lookup should hit the cache');
});

test('species PDF has one labeled slot per variant', async () => {
  const res = await fetch(`${base}/api/games/pokemon/species/Pikachu/printable.pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Pikachu_master_set\.pdf/);
  assert.equal(res.headers.get('x-missing-images'), '3', 'three distinct cards have no image');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('species lookup rejects blank names and games without it', async () => {
  assert.equal((await json('/api/games/pokemon/species/%20')).status, 400);
  assert.equal((await json('/api/games/mtg/species/Pikachu')).status, 404);
});

test('matching by hand: confirm a no-dex card, remove one, force the dex, search and add', async () => {
  const put = (body) => json('/api/games/pokemon/species/Pikachu/matches', { method: 'PUT', body: JSON.stringify(body) });
  const slots = async () => (await json('/api/games/pokemon/species/Pikachu')).body;

  // Confirming nodex-1 moves it into the dated list: 2015 sits between 2010 and 2023.
  const libre = (await slots()).slots.find((sl) => sl.cardId === 'nodex-1');
  const confirmed = await put({ include: [{ ...libre, variants: ['Normal'] }] });
  assert.equal(confirmed.body.include[0].id, 'nodex-1');
  let body = await slots();
  assert.deepEqual([...new Set(body.slots.map((sl) => sl.cardId))], ['old-1', 'nodex-1', 'sv1-2']);
  assert.ok(body.slots.every((sl) => !sl.noDex));
  assert.equal(body.slots[1].manual, true);

  // Removing a card drops it from the slots and the PDF, and reports it so it can be restored.
  await put({ exclude: ['sv1-2'] });
  body = await slots();
  assert.deepEqual([...new Set(body.slots.map((sl) => sl.cardId))], ['old-1', 'nodex-1']);
  assert.deepEqual(body.excluded.map((c) => c.id), ['sv1-2']);
  assert.equal(body.slots.find((sl) => sl.cardId === 'nodex-1').noDex, true, 'unmatched again once the include is gone');

  // A forced dex reaches the source and uses its own cache entry.
  const before = calls.species;
  await put({ dex: 25 });
  await slots();
  assert.equal(calls.speciesOpts.dex, 25);
  assert.equal(calls.species, before + 1);
  await slots();
  assert.equal(calls.species, before + 1, 'cached under the new key');
  assert.equal((await json('/api/games/pokemon/species/Pikachu')).body.matches.dex, 25);

  // Search results are sanitized (no http image) and can be added.
  const found = await json('/api/games/pokemon/card-search?q=libre');
  assert.equal(found.body[0].image, null);
  await put({ dex: 25, include: [found.body[0]] });
  assert.ok((await slots()).slots.some((sl) => sl.cardId === 'xy-1' && sl.manual));

  // Clearing everything removes the record from the file.
  await put({});
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'collection.json'), 'utf8'));
  assert.equal(saved.speciesMatches['pokemon:pikachu'], undefined);
});

test('matches reject blank names and bad dex numbers', async () => {
  const bad = await json('/api/games/pokemon/species/%20/matches', { method: 'PUT', body: '{}' });
  assert.equal(bad.status, 400);
  const sane = await json('/api/games/pokemon/species/Pikachu/matches', { method: 'PUT', body: JSON.stringify({ dex: -3, include: [{ name: 'no id' }], exclude: [42] }) });
  assert.deepEqual(sane.body, { dex: null, include: [], exclude: [] });
});

test('saved collections list on the home page with progress from cached lookups only', async () => {
  const put = (type, name) => json(`/api/games/pokemon/collections/${type}/${encodeURIComponent(name)}`, { method: 'PUT' });
  assert.deepEqual((await json('/api/games/pokemon/collections')).body, []);

  await put('species', 'Pikachu');
  await put('artist', 'Yuka Morii');
  await put('species', 'Raichu');
  const before = { ...calls };
  const { body } = await json('/api/games/pokemon/collections');
  assert.deepEqual(body.map((c) => [c.id, c.name]), [['species:pikachu', 'Pikachu'], ['artist:yuka morii', 'Yuka Morii'], ['species:raichu', 'Raichu']]);
  // Both were looked up earlier, so they have progress; Raichu never was, so listing it must not call the API.
  assert.equal(body[0].progress.cards, 3);
  assert.equal(body[0].progress.variantsOwned, 1, 'only the sv1-2 Reverse Holo copy from an earlier test is owned');
  assert.equal(body[1].progress.cards, 3);
  assert.equal(body[2].progress, null);
  assert.deepEqual([calls.species, calls.artist], [before.species, before.artist]);

  // Saving again with different capitals replaces the entry; removing drops it.
  await put('species', 'PIKACHU');
  assert.deepEqual((await json('/api/games/pokemon/collections')).body.map((c) => c.name), ['Yuka Morii', 'Raichu', 'PIKACHU']);
  const del = await json('/api/games/pokemon/collections/species/raichu', { method: 'DELETE' });
  assert.deepEqual(del.body.map((c) => c.id), ['artist:yuka morii', 'species:pikachu']);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'collection.json'), 'utf8'));
  assert.equal(saved.savedCollections.pokemon.length, 2);
});

test('saved collections reject bad types and blank names, and unsupported games', async () => {
  assert.equal((await json('/api/games/pokemon/collections/set/x', { method: 'PUT' })).status, 400);
  assert.equal((await json('/api/games/pokemon/collections/species/%20', { method: 'PUT' })).status, 400);
  assert.equal((await json('/api/games/mtg/collections')).status, 404);
});
