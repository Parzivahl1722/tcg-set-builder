import { getJson } from '../http.js';

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
    image: c.images?.small ?? null,
    imageLarge: c.images?.large ?? null,
    variants: pokemonVariants(c),
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

export default { id: 'pokemon', name: 'Pokémon', fetchSets, fetchCards };
