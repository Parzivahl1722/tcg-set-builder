import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artistMatches, fetchCardsByArtist, normArtistCard, normCard as pokeCard, pokemonVariants } from '../server/sources/pokemon.js';
import { normCard as lorCard, lorcanaVariants } from '../server/sources/lorcana.js';

test('pokemon variants come from tcgplayer price keys', () => {
  const card = { rarity: 'Common', tcgplayer: { prices: { normal: {}, reverseHolofoil: {} } } };
  assert.deepEqual(pokemonVariants(card), ['Normal', 'Reverse Holo']);
  assert.deepEqual(pokemonVariants({ tcgplayer: { prices: { '1stEditionHolofoil': {}, unlimitedHolofoil: {} } } }), ['1st Edition Holo', 'Unlimited Holo']);
  assert.deepEqual(pokemonVariants({ tcgplayer: { prices: { someNewKey: {} } } }), ['Some New Key']);
});

test('pokemon variants fall back to rarity when prices are missing', () => {
  assert.deepEqual(pokemonVariants({ rarity: 'Uncommon' }), ['Normal', 'Reverse Holo']);
  assert.deepEqual(pokemonVariants({ rarity: 'Rare Holo' }), ['Holo', 'Reverse Holo']);
  assert.deepEqual(pokemonVariants({ rarity: 'Special Illustration Rare' }), ['Holo']);
  assert.deepEqual(pokemonVariants({ rarity: 'Promo' }), ['Normal']);
  assert.deepEqual(pokemonVariants({}), ['Normal']);
});

test('pokemon card normalizes API shape', () => {
  const c = pokeCard({
    id: 'sv1-1', name: 'Pineco', number: '1', rarity: 'Common',
    images: { small: 'https://images.pokemontcg.io/sv1/1.png', large: 'https://images.pokemontcg.io/sv1/1_hires.png' },
    tcgplayer: { prices: { normal: {}, reverseHolofoil: {} } },
  });
  assert.deepEqual(c, {
    id: 'sv1-1', number: '1', name: 'Pineco', rarity: 'Common', artist: null,
    image: 'https://images.pokemontcg.io/sv1/1.png', imageLarge: 'https://images.pokemontcg.io/sv1/1_hires.png',
    variants: ['Normal', 'Reverse Holo'],
  });
});

test('lorcana variants', () => {
  assert.deepEqual(lorcanaVariants({ rarity: 'Common' }), ['Normal', 'Foil']);
  assert.deepEqual(lorcanaVariants({ rarity: 'Super_rare' }), ['Normal', 'Foil']);
  assert.deepEqual(lorcanaVariants({ rarity: 'Enchanted' }), ['Foil']);
  assert.deepEqual(lorcanaVariants({ rarity: 'Promo', prices: { usd: null, usd_foil: '4.00' } }), ['Foil']);
  assert.deepEqual(lorcanaVariants({ rarity: 'Promo', prices: { usd: null, usd_foil: null } }), ['Normal', 'Foil']);
});

test('lorcana card normalizes API shape', () => {
  const c = lorCard({
    id: 'crd_1', name: 'Ariel', version: 'On Human Legs', collector_number: '1', rarity: 'Uncommon',
    image_uris: { digital: { small: 's.avif', normal: 'n.avif', large: 'l.avif' } },
  });
  assert.equal(c.name, 'Ariel – On Human Legs');
  assert.equal(c.number, '1');
  assert.equal(c.image, 'n.avif');
  assert.equal(c.imageLarge, 'l.avif');
  assert.deepEqual(c.variants, ['Normal', 'Foil']);
});

test('pokemon card keeps the artist', () => {
  assert.equal(pokeCard({ id: 'x', artist: 'Yuka Morii' }).artist, 'Yuka Morii');
});

test('artist matching ignores case, accents and spacing, and finds collaborations', () => {
  assert.ok(artistMatches('Yuka  Morii', 'yuka morii'));
  assert.ok(artistMatches('Atsuko Nishida, Yuka Morii', 'Yuka Morii'));
  assert.ok(artistMatches('Naoki Saito', 'naoki  saitō'));
  assert.ok(!artistMatches('Mitsuhiro Arita', 'Yuka Morii'));
  assert.ok(!artistMatches(null, 'Yuka Morii'));
  assert.ok(!artistMatches('Yuka Morii', ''));
});

test('artist cards carry their set', () => {
  const c = normArtistCard({ id: 'sv1-1', number: '1', name: 'A', artist: 'X', set: { id: 'sv1', name: 'Scarlet & Violet', releaseDate: '2023/03/31' } });
  assert.deepEqual([c.setId, c.setName, c.releaseDate], ['sv1', 'Scarlet & Violet', '2023-03-31']);
});

test('artist lookup queries the API and drops non-matching rows', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return Response.json({
      totalCount: 2,
      data: [
        { id: 'a-1', number: '1', name: 'One', artist: 'Yuka Morii', set: { id: 'a', name: 'A' } },
        { id: 'a-2', number: '2', name: 'Two', artist: 'Someone Else', set: { id: 'a', name: 'A' } },
      ],
    });
  });
  const cards = await fetchCardsByArtist('Yuka Morii');
  assert.deepEqual(cards.map((c) => c.id), ['a-1']);
  assert.match(decodeURIComponent(urls[0]), /q=artist:"Yuka Morii"/);
});

test('artist lookup falls back to scanning the data repo', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('api.pokemontcg.io')) return new Response('down', { status: 503 });
    if (u.endsWith('/sets/en.json')) return Response.json([{ id: 'a', name: 'A', releaseDate: '2020/01/01' }, { id: 'b', name: 'B' }]);
    if (u.endsWith('/cards/en/a.json')) return Response.json([{ id: 'a-1', number: '1', name: 'One', artist: 'Yuka Morii' }]);
    return Response.json([{ id: 'b-1', number: '1', name: 'Uno', artist: 'Other' }]);
  });
  const cards = await fetchCardsByArtist('yuka morii');
  assert.deepEqual(cards.map((c) => [c.id, c.setName, c.releaseDate]), [['a-1', 'A', '2020-01-01']]);
});
