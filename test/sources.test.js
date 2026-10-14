import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustCard, artistMatches, fetchCardsByArtist, fetchCardsBySpecies, resolveDex, searchCards, selectSpecies, normArtistCard, normCard as pokeCard, pokemonVariants } from '../server/sources/pokemon.js';
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

// ---- TCGdex ----

const respond = (routes) => async (url) => {
  const u = decodeURIComponent(String(url));
  for (const [match, body] of routes) {
    if (u.includes(match)) return typeof body === 'function' ? body(u) : body instanceof Response ? body.clone() : Response.json(body);
  }
  return new Response('not found', { status: 404, statusText: 'Not Found' });
};

test('tcgdex set ids line up with the Pokémon TCG API ids', async () => {
  const { normSetId, stripZeros, setIdOfCard } = await import('../server/sources/tcgdex.js');
  assert.deepEqual(['sv07', 'sv03.5', 'me02.5', 'me01', 'svp', 'swsh12', 'A1'].map(normSetId), ['sv7', 'sv3pt5', 'me2pt5', 'me1', 'svp', 'swsh12', 'a1']);
  assert.equal(stripZeros('091'), '91');
  assert.equal(stripZeros('TG01'), 'TG01');
  assert.equal(setIdOfCard({ id: 'sv07-091', localId: '091' }), 'sv07');
  assert.equal(setIdOfCard({ id: 'swsh9tg-TG01', localId: 'TG01' }), 'swsh9tg');
});

test('the set list gains only new non-Pocket TCGdex sets the Pokémon TCG data lacks', async (t) => {
  const { fetchSets } = await import('../server/sources/pokemon.js');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', respond([
    ['api.pokemontcg.io/v2/sets', { totalCount: 2, data: [
      { id: 'sv1', name: 'Scarlet & Violet', series: 'S&V', releaseDate: '2023/03/31' },
      { id: 'me55c', name: '30th Celebration: Classic Collection', series: 'ME', releaseDate: '2026/09/16' },
    ] }],
    ['tcgdex.net/v2/en/sets?serie=tcgp', [{ id: 'A1' }]],
    ['tcgdex.net/v2/en/sets/mep', { id: 'mep', name: 'MEP Black Star Promos', releaseDate: '2025-09-26', serie: { id: 'me', name: 'Mega Evolution' }, cardCount: { total: 112, official: 0 }, logo: 'https://a/logo' }],
    ['tcgdex.net/v2/en/sets/old', { id: 'old', name: 'Old Kit', releaseDate: '2010-05-01', serie: { id: 'tk', name: 'Kits' } }],
    ['tcgdex.net/v2/en/sets/30th-c', { id: '30th-c', name: '30th Classic Collection', releaseDate: '2026-09-16', serie: { id: 'me', name: 'Mega Evolution' } }],
    ['tcgdex.net/v2/en/sets', [
      { id: 'sv01', name: 'Scarlet & Violet' }, { id: 'mep', name: 'MEP Black Star Promos' }, { id: 'A1', name: 'Genetic Apex' },
      { id: 'old', name: 'Old Kit' }, { id: '30th-c', name: '30th Classic Collection' },
    ]],
  ]));
  const sets = await fetchSets();
  assert.deepEqual(sets.map((s) => s.id), ['me55c', 'mep', 'sv1'], 'newest first; Pocket, old and duplicate sets left out');
  assert.deepEqual([sets[1].name, sets[1].series, sets[1].releaseDate, sets[1].total, sets[1].logo], ['MEP Black Star Promos', 'Mega Evolution', '2025-09-26', 112, 'https://a/logo.webp']);
});

test('the set list still loads when TCGdex is down', async (t) => {
  const { fetchSets } = await import('../server/sources/pokemon.js');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', respond([['api.pokemontcg.io/v2/sets', { totalCount: 1, data: [{ id: 'sv1', name: 'S&V', releaseDate: '2023/03/31' }] }]]));
  assert.deepEqual((await fetchSets()).map((s) => s.id), ['sv1']);
});

test('a set the Pokémon TCG sources lack is loaded from TCGdex', async (t) => {
  const { fetchCards } = await import('../server/sources/pokemon.js');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', respond([
    ['api.pokemontcg.io/v2/cards', { totalCount: 0, data: [] }],
    ['tcgdex.net/v2/en/sets/mep', { id: 'mep', cards: [{ id: 'mep-005', localId: '005' }, { id: 'mep-006', localId: '006' }] }],
    ['tcgdex.net/v2/en/sets', [{ id: 'mep', name: 'MEP Black Star Promos' }]],
    ['tcgdex.net/v2/en/cards/mep-005', { id: 'mep-005', localId: '005', name: 'Drifloon', rarity: 'Promo', illustrator: 'Shimaris Yukichi', image: 'https://a/005', variants: { normal: true, reverse: false, holo: true } }],
    ['tcgdex.net/v2/en/cards/mep-006', { id: 'mep-006', localId: '006', name: 'Drifblim', rarity: 'None', variants: [{ type: 'reverse' }] }],
  ]));
  const cards = await fetchCards('mep');
  assert.deepEqual(cards[0], {
    id: 'mep-5', number: '5', name: 'Drifloon', rarity: 'Promo', artist: 'Shimaris Yukichi',
    image: 'https://a/005/low.webp', imageLarge: 'https://a/005/high.webp', variants: ['Normal', 'Holo'],
  });
  assert.deepEqual([cards[1].rarity, cards[1].artist, cards[1].variants], ['Unknown', null, ['Reverse Holo']]);
});

test('a set nobody has fails with every reason listed', async (t) => {
  const { fetchCards } = await import('../server/sources/pokemon.js');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', respond([['api.pokemontcg.io/v2/cards', { totalCount: 0, data: [] }], ['tcgdex.net/v2/en/sets', []]]));
  await assert.rejects(() => fetchCards('nope'), /No card source has nope.*API.*GitHub data.*TCGdex/);
});

test('TCGdex artist credits map onto the app\'s sets and card ids', async (t) => {
  const { fetchSupplementCardsByArtist } = await import('../server/sources/pokemon.js');
  t.mock.method(globalThis, 'fetch', respond([
    ['tcgdex.net/v2/en/illustrators/Shimaris Yukichi', { name: 'x', cards: [
      { id: 'sv07-091', localId: '091', name: 'Gulpin', image: 'https://a/91' },
      { id: 'sv10.5b-129', localId: '129', name: 'Dwebble', image: 'https://a/129' },
      { id: 'mep-005', localId: '005', name: 'Drifloon' },
      { id: 'zzz-001', localId: '001', name: 'Lost' },
    ] }],
    ['tcgdex.net/v2/en/sets', [{ id: 'sv07', name: 'Stellar Crown' }, { id: 'sv10.5b', name: 'Black Bolt' }, { id: 'mep', name: 'MEP Black Star Promos' }, { id: 'zzz', name: 'Unlisted' }]],
  ]));
  const sets = [
    { id: 'sv7', name: 'Stellar Crown', releaseDate: '2024-09-13' },
    { id: 'zsv10pt5', name: 'Black Bolt', releaseDate: '2025-07-18' },
    { id: 'mep', name: 'MEP Black Star Promos', releaseDate: '2025-09-26' },
  ];
  const { cards, skipped } = await fetchSupplementCardsByArtist('Shimaris Yukichi', sets);
  assert.deepEqual(cards.map((c) => [c.id, c.number, c.setName]), [['sv7-91', '91', 'Stellar Crown'], ['zsv10pt5-129', '129', 'Black Bolt'], ['mep-5', '5', 'MEP Black Star Promos']]);
  assert.equal(skipped, 1, 'a card in a set the app does not list is counted, not dropped silently');
  assert.deepEqual([cards[0].image, cards[0].imageLarge, cards[0].artist], ['https://a/91/low.webp', 'https://a/91/high.webp', 'Shimaris Yukichi']);
});

test('an artist TCGdex has never heard of is an empty result, not an error', async (t) => {
  const { fetchSupplementCardsByArtist } = await import('../server/sources/pokemon.js');
  t.mock.method(globalThis, 'fetch', respond([['tcgdex.net/v2/en/sets', []]]));
  assert.deepEqual(await fetchSupplementCardsByArtist('Nobody', []), { cards: [], skipped: 0 });
});

test('adjustCard drops Reverse Holo only in sets where every card is foil', () => {
  const card = (id, variants) => ({ id, variants });
  assert.deepEqual(adjustCard(card('me55-1', ['Normal', 'Reverse Holo'])).variants, ['Normal']);
  assert.deepEqual(adjustCard(card('me55-9', ['Holo', 'Reverse Holo'])).variants, ['Holo']);
  assert.deepEqual(adjustCard(card('me55c-58', ['Normal', 'Reverse Holo'])).variants, ['Normal']);
  // Other sets, including the 2021 Celebrations Classic Collection, are untouched.
  const kept = card('cel25c-4', ['Normal', 'Reverse Holo']);
  assert.equal(adjustCard(kept), kept);
  const sv = card('sv1-1', ['Normal', 'Reverse Holo']);
  assert.equal(adjustCard(sv), sv);
  // A set id that merely starts the same way is not a match.
  assert.deepEqual(adjustCard(card('me55x-1', ['Normal', 'Reverse Holo'])).variants, ['Normal', 'Reverse Holo']);
});

const dexCard = (id, name, nationalPokedexNumbers, extra = {}) => ({ id, number: '1', name, supertype: 'Pokémon', nationalPokedexNumbers, ...extra });

test('resolveDex votes on cards named exactly that, ignoring form suffixes and accents', () => {
  const cards = [
    dexCard('a', 'Pikachu', [25]), dexCard('b', 'Pikachu VMAX', [25]), dexCard('c', 'Pikachu-GX', [25]),
    dexCard('d', 'Pikachu & Zekrom-GX', [25, 644]), dexCard('e', 'Raichu', [26]), dexCard('f', 'Flabébé', [669]),
  ];
  assert.equal(resolveDex(cards, 'pikachu'), 25);
  assert.equal(resolveDex(cards, 'Flabebe'), 669);
  assert.equal(resolveDex(cards, 'Nope'), null);
  // Only form-named cards exist: fall back to containment.
  assert.equal(resolveDex([dexCard('g', 'Detective Pikachu', [25])], 'Pikachu'), 25);
});

test('selectSpecies takes dex matches (multi-species too) and name matches that have no dex', () => {
  const cards = [
    dexCard('a', 'Pikachu', [25]),
    dexCard('b', 'Pikachu & Zekrom-GX', [25, 644]),
    dexCard('c', 'Pikachu Libre', [], { supertype: 'Trainer' }),
    dexCard('d', "Ash's Pikachu", undefined, { supertype: 'Trainer' }),
    dexCard('e', 'Pikachuman', undefined),
    dexCard('f', 'Raichu', [26]),
    dexCard('g', 'Pikachu clone', [999]),
    dexCard('a', 'Pikachu', [25]),
  ];
  assert.deepEqual(selectSpecies(cards, { dex: 25, name: 'Pikachu' }).map((c) => c.id), ['a', 'b', 'c', 'd']);
  // A bare dex number has no name to match, so no-dex cards are not guessed at.
  assert.deepEqual(selectSpecies(cards, { dex: 26 }).map((c) => c.id), ['f']);
});

test('species lookup resolves the name, then queries by dex number', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = decodeURIComponent(String(url));
    urls.push(u);
    const set = { id: 'a', name: 'A', releaseDate: '2020/01/01' };
    const rows = u.includes('nationalPokedexNumbers:25')
      ? [dexCard('a-1', 'Pikachu', [25], { set }), dexCard('a-2', 'Pikachu V', [25], { set })]
      : [dexCard('a-1', 'Pikachu', [25], { set }), dexCard('a-3', 'Pikachu Libre', undefined, { supertype: 'Trainer', set })];
    return Response.json({ totalCount: rows.length, data: rows });
  });
  const cards = await fetchCardsBySpecies('pikachu');
  assert.match(urls[0], /q=name:"pikachu"/);
  assert.match(urls[1], /q=nationalPokedexNumbers:25/);
  assert.deepEqual(cards.map((c) => [c.id, c.dex.length === 0, c.setName, c.releaseDate]), [
    ['a-1', false, 'A', '2020-01-01'], ['a-2', false, 'A', '2020-01-01'], ['a-3', true, 'A', '2020-01-01'],
  ]);
});

test('species lookup by dex number skips the name query; falls back to the data repo', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    urls.push(decodeURIComponent(u));
    if (u.includes('api.pokemontcg.io')) return new Response('down', { status: 503 });
    if (u.endsWith('/sets/en.json')) return Response.json([{ id: 'a', name: 'A', releaseDate: '2020/01/01' }]);
    return Response.json([dexCard('a-1', 'Pikachu', [25]), dexCard('a-2', 'Raichu', [26])]);
  });
  const cards = await fetchCardsBySpecies('#25');
  assert.match(urls[0], /q=nationalPokedexNumbers:25/);
  assert.deepEqual(cards.map((c) => [c.id, c.setName]), [['a-1', 'A']]);
});

test('a forced dex overrides the name lookup but still matches no-dex cards by name', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = decodeURIComponent(String(url));
    urls.push(u);
    const rows = u.includes('nationalPokedexNumbers:26')
      ? [dexCard('r-1', 'Raichu', [26])]
      : [dexCard('p-1', 'Pikachu', [25]), dexCard('p-2', 'Pikachu Libre', [], { supertype: 'Trainer' })];
    return Response.json({ totalCount: rows.length, data: rows });
  });
  const cards = await fetchCardsBySpecies('pikachu', { dex: 26 });
  assert.match(urls[1], /nationalPokedexNumbers:26/);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['p-2', 'r-1']);
});

test('card search takes partial words, keeps name matches, and falls back to the data repo', async (t) => {
  assert.deepEqual(await searchCards('a'), []);
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    urls.push(decodeURIComponent(u));
    if (u.includes('api.pokemontcg.io')) return new Response('down', { status: 503 });
    if (u.endsWith('/sets/en.json')) return Response.json([{ id: 'a', name: 'A', releaseDate: '2020/01/01' }]);
    return Response.json([dexCard('a-1', 'Pikachu Libre', []), dexCard('a-2', 'Raichu', [26])]);
  });
  const cards = await searchCards('chu lib');
  assert.match(urls[0], /q=name:"chu lib"/);
  assert.deepEqual(cards.map((c) => [c.id, c.setName]), [['a-1', 'A']]);
});
