import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCard as pokeCard, pokemonVariants } from '../server/sources/pokemon.js';
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
    id: 'sv1-1', number: '1', name: 'Pineco', rarity: 'Common',
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
