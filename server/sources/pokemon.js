import { getJson } from '../http.js';
import { artistMatches } from '../collection.js';
import * as tcgdex from './tcgdex.js';

export { artistMatches };

const API = 'https://api.pokemontcg.io/v2';
// Same data as the API, published by the PokemonTCG project. Used when the API is down.
const RAW = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';

// tcgplayer price keys tell us which printings of a card actually exist.
const PRICE_VARIANTS = {
  normal: 'Normal',
  holofoil: 'Holo',
  reverseHolofoil: 'Reverse Holo',
  '1stEditionNormal': '1st Edition',
  '1stEditionHolofoil': '1st Edition Holo',
  unlimitedHolofoil: 'Unlimited Holo',
};

function apiHeaders() {
  const key = process.env.POKEMONTCG_API_KEY;
  return key ? { 'X-Api-Key': key } : {};
}

function normSet(s) {
  return {
    id: s.id,
    name: s.name,
    series: s.series,
    releaseDate: s.releaseDate ? s.releaseDate.replaceAll('/', '-') : null,
    printedTotal: s.printedTotal ?? null,
    total: s.total ?? null,
    logo: s.images?.logo ?? null,
    symbol: s.images?.symbol ?? null,
  };
}

export function pokemonVariants(card) {
  const prices = card.tcgplayer?.prices;
  if (prices && Object.keys(prices).length) {
    return Object.keys(prices).map(
      (k) => PRICE_VARIANTS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    );
  }
  const rarity = card.rarity ?? '';
  if (['Common', 'Uncommon', 'Rare'].includes(rarity)) return ['Normal', 'Reverse Holo'];
  if (rarity === 'Rare Holo') return ['Holo', 'Reverse Holo'];
  if (rarity === 'Promo' || !rarity) return ['Normal'];
  return ['Holo'];
}

export function normCard(c) {
  return {
    id: c.id,
    number: c.number,
    name: c.name,
    rarity: c.rarity ?? 'Unknown',
    artist: c.artist ?? null,
    image: c.images?.small ?? null,
    imageLarge: c.images?.large ?? null,
    variants: pokemonVariants(c),
  };
}

// A card plus where it was printed, for lists that span sets (artist pages).
export function normArtistCard(c, set = c.set) {
  return {
    ...normCard(c),
    setId: set?.id ?? null,
    setName: set?.name ?? null,
    releaseDate: set?.releaseDate ? set.releaseDate.replaceAll('/', '-') : null,
  };
}

const words = (name) => new Set(String(name).toLowerCase().match(/[a-z0-9]+/g) ?? []);
const squash = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isSubset = (a, b) => [...a].every((w) => b.has(w));

// The app's set that a TCGdex set corresponds to, by normalized id or by name.
export function findAppSet(sets, t) {
  return sets.find((s) => s.id === tcgdex.normSetId(t.id)) ?? sets.find((s) => squash(s.name) === squash(t.name));
}

// Older sets TCGdex "lacks a match" for are mostly the same set under another name (trainer kits, McDonald's),
// so only sets from this date on are added. That is where the Pokémon TCG data is behind.
const TCGDEX_EXTRA_SETS_FROM = '2025-01-01';

function normTcgdexSet(d) {
  return {
    id: tcgdex.normSetId(d.id),
    name: d.name,
    series: d.serie?.name ?? 'Other',
    releaseDate: d.releaseDate ?? null,
    printedTotal: d.cardCount?.official || null,
    total: d.cardCount?.total ?? null,
    logo: d.logo ? `${d.logo}.webp` : null,
    symbol: d.symbol ? `${d.symbol}.webp` : null,
  };
}

// Recent non-Pocket TCGdex sets the Pokémon TCG data doesn't list.
export async function tcgdexExtraSets(known) {
  const [all, pocket] = await Promise.all([tcgdex.fetchSetsBrief(), tcgdex.fetchPocketSetIds().catch(() => new Set())]);
  const unmatched = all.filter((t) => !pocket.has(t.id) && !findAppSet(known, t));
  const details = await tcgdex.mapLimit(unmatched, 6, (t) => tcgdex.fetchSet(t.id).catch(() => null));
  return details
    .filter((d) => d && d.serie?.id !== 'tcgp' && (d.releaseDate ?? '') >= TCGDEX_EXTRA_SETS_FROM)
    // The same release under a longer or shorter name (30th Classic Collection vs 30th Celebration: Classic Collection).
    .filter((d) => !known.some((k) => k.releaseDate === d.releaseDate && (isSubset(words(k.name), words(d.name)) || isSubset(words(d.name), words(k.name)))))
    .map(normTcgdexSet);
}

export async function fetchSets() {
  let sets;
  try {
    const all = [];
    for (let page = 1; ; page++) {
      const r = await getJson(`${API}/sets?orderBy=-releaseDate&pageSize=250&page=${page}`, { headers: apiHeaders() });
      all.push(...r.data);
      if (all.length >= r.totalCount || r.data.length === 0) break;
    }
    sets = all.map(normSet);
  } catch (err) {
    console.warn(`[pokemon] API failed (${err.message}); using GitHub data`);
    const raw = await getJson(`${RAW}/sets/en.json`);
    sets = raw.map(normSet).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  }
  try {
    sets.push(...(await tcgdexExtraSets(sets)));
    sets.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  } catch (err) {
    console.warn(`[pokemon] TCGdex sets unavailable (${err.message}); listing the Pokémon TCG sets only`);
  }
  return sets;
}

const TCGDEX_VARIANTS = { normal: 'Normal', reverse: 'Reverse Holo', holo: 'Holo', firstEdition: '1st Edition' };

// TCGdex card detail -> the app's card shape. Ids follow the Pokémon TCG convention: "<setId>-<number>".
export function normTcgdexCard(c, setId) {
  const number = tcgdex.stripZeros(c.localId);
  const rarity = !c.rarity || c.rarity === 'None' ? 'Unknown' : c.rarity.replace(/\b\w/g, (ch) => ch.toUpperCase());
  const flags = Array.isArray(c.variants) ? c.variants.map((v) => v.type) : Object.entries(c.variants ?? {}).filter(([, on]) => on === true).map(([k]) => k);
  const variants = [...new Set(flags.map((k) => TCGDEX_VARIANTS[k]).filter(Boolean))];
  return {
    id: `${setId}-${number}`,
    number,
    name: c.name,
    rarity,
    artist: c.illustrator ?? null,
    image: tcgdex.imageUrl(c.image, 'low'),
    imageLarge: tcgdex.imageUrl(c.image, 'high'),
    variants: variants.length ? variants : pokemonVariants({ rarity }),
  };
}

async function cardsViaApi(setId) {
  const cards = [];
  for (let page = 1; ; page++) {
    const q = encodeURIComponent(`set.id:${setId}`);
    const r = await getJson(`${API}/cards?q=${q}&pageSize=250&page=${page}`, { headers: apiHeaders() });
    cards.push(...r.data);
    if (cards.length >= r.totalCount || r.data.length === 0) break;
  }
  if (!cards.length) throw new Error('no cards');
  return cards.map(normCard);
}

async function cardsViaGithub(setId) {
  const raw = await getJson(`${RAW}/cards/en/${encodeURIComponent(setId)}.json`);
  return raw.map(normCard);
}

async function cardsViaTcgdex(setId) {
  const t = (await tcgdex.fetchSetsBrief()).find((s) => tcgdex.normSetId(s.id) === setId);
  if (!t) throw new Error('not a TCGdex set');
  const set = await tcgdex.fetchSet(t.id);
  const cards = await tcgdex.mapLimit(set.cards ?? [], 8, (c) => tcgdex.fetchCard(c.id));
  if (!cards.length) throw new Error('no cards');
  return cards.map((c) => normTcgdexCard(c, setId));
}

export async function fetchCards(setId) {
  const failures = [];
  for (const [label, load] of [['API', cardsViaApi], ['GitHub data', cardsViaGithub], ['TCGdex', cardsViaTcgdex]]) {
    try {
      return await load(setId);
    } catch (err) {
      console.warn(`[pokemon] ${label} failed for ${setId} (${err.message})`);
      failures.push(`${label}: ${err.message}`);
    }
  }
  throw new Error(`No card source has ${setId} (${failures.join('; ')})`);
}

// Every printing by one artist, across all sets.
export async function fetchCardsByArtist(name) {
  const wanted = String(name).replaceAll('"', '').trim();
  if (!wanted) return [];
  try {
    const cards = [];
    for (let page = 1; ; page++) {
      const q = encodeURIComponent(`artist:"${wanted}"`);
      const r = await getJson(`${API}/cards?q=${q}&pageSize=250&page=${page}`, { headers: apiHeaders() });
      cards.push(...r.data);
      if (cards.length >= r.totalCount || r.data.length === 0) break;
    }
    return cards.filter((c) => artistMatches(c.artist, wanted)).map((c) => normArtistCard(c));
  } catch (err) {
    // The API has no cheap substitute for an artist query, so scan every set file from the data repo.
    console.warn(`[pokemon] artist query failed (${err.message}); scanning GitHub data`);
    const sets = await getJson(`${RAW}/sets/en.json`);
    const out = [];
    for (let i = 0; i < sets.length; i += 8) {
      const batch = await Promise.all(sets.slice(i, i + 8).map(async (set) => {
        const raw = await getJson(`${RAW}/cards/en/${encodeURIComponent(set.id)}.json`);
        return raw.filter((c) => artistMatches(c.artist, wanted)).map((c) => normArtistCard(c, set));
      }));
      out.push(...batch.flat());
    }
    return out;
  }
}

// Cards TCGdex credits to an artist, mapped onto the app's sets and card ids. The Pokémon TCG data leaves
// the artist blank for whole recent sets, so this is how those cards reach an artist page.
// `skipped` counts cards whose set the app doesn't list (refresh the set list to pick up new ones).
export async function fetchSupplementCardsByArtist(name, sets) {
  const wanted = String(name).trim();
  if (!wanted) return { cards: [], skipped: 0 };
  const [found, tcgSets] = await Promise.all([tcgdex.fetchIllustratorCards(wanted), tcgdex.fetchSetsBrief()]);
  const cards = [];
  let skipped = 0;
  for (const c of found) {
    const tcgSetId = tcgdex.setIdOfCard(c);
    const t = tcgSets.find((x) => x.id === tcgSetId) ?? { id: tcgSetId, name: '' };
    const set = findAppSet(sets, t);
    if (!set) { skipped++; continue; }
    const number = tcgdex.stripZeros(c.localId);
    cards.push({
      id: `${set.id}-${number}`,
      number,
      name: c.name,
      rarity: 'Unknown',
      artist: wanted,
      image: tcgdex.imageUrl(c.image, 'low'),
      imageLarge: tcgdex.imageUrl(c.image, 'high'),
      variants: [],
      setId: set.id,
      setName: set.name,
      releaseDate: set.releaseDate,
    });
  }
  return { cards, skipped };
}

export default { id: 'pokemon', name: 'Pokémon', fetchSets, fetchCards, fetchCardsByArtist, fetchSupplementCardsByArtist };
