import { getJson } from '../http.js';
import { artistMatches } from '../collection.js';

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

export async function fetchSets() {
  try {
    const sets = [];
    for (let page = 1; ; page++) {
      const r = await getJson(`${API}/sets?orderBy=-releaseDate&pageSize=250&page=${page}`, { headers: apiHeaders() });
      sets.push(...r.data);
      if (sets.length >= r.totalCount || r.data.length === 0) break;
    }
    return sets.map(normSet);
  } catch (err) {
    console.warn(`[pokemon] API failed (${err.message}); using GitHub data`);
    const raw = await getJson(`${RAW}/sets/en.json`);
    return raw.map(normSet).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
  }
}

export async function fetchCards(setId) {
  try {
    const cards = [];
    for (let page = 1; ; page++) {
      const q = encodeURIComponent(`set.id:${setId}`);
      const r = await getJson(`${API}/cards?q=${q}&pageSize=250&page=${page}`, { headers: apiHeaders() });
      cards.push(...r.data);
      if (cards.length >= r.totalCount || r.data.length === 0) break;
    }
    return cards.map(normCard);
  } catch (err) {
    console.warn(`[pokemon] API failed for ${setId} (${err.message}); using GitHub data`);
    const raw = await getJson(`${RAW}/cards/en/${encodeURIComponent(setId)}.json`);
    return raw.map(normCard);
  }
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

export default { id: 'pokemon', name: 'Pokémon', fetchSets, fetchCards, fetchCardsByArtist };
