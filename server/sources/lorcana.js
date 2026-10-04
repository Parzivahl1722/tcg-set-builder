import { getJson } from '../http.js';

const API = 'https://api.lorcast.com/v0';
const FOIL_ONLY = new Set(['Enchanted', 'Epic', 'Iconic']);

function rarityName(r) {
  return r ? r.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Unknown';
}

function normSet(s) {
  return {
    id: s.code,
    name: s.name,
    series: 'Disney Lorcana',
    releaseDate: s.released_at ?? null,
    printedTotal: null,
    total: null,
    logo: null,
    symbol: null,
  };
}

export function lorcanaVariants(card) {
  const rarity = rarityName(card.rarity);
  if (FOIL_ONLY.has(rarity)) return ['Foil'];
  // Promos are often foil-only; trust prices when exactly one printing has one.
  if (rarity === 'Promo' && card.prices) {
    const { usd, usd_foil: foil } = card.prices;
    if (usd == null && foil != null) return ['Foil'];
    if (usd != null && foil == null) return ['Normal'];
  }
  return ['Normal', 'Foil'];
}

export function normCard(c) {
  const imgs = c.image_uris?.digital ?? {};
  return {
    id: c.id,
    number: c.collector_number,
    name: c.version ? `${c.name} – ${c.version}` : c.name,
    rarity: rarityName(c.rarity),
    image: imgs.normal ?? imgs.small ?? null,
    imageLarge: imgs.large ?? imgs.normal ?? null,
    variants: lorcanaVariants(c),
  };
}

export async function fetchSets() {
  const r = await getJson(`${API}/sets`);
  return r.results.map(normSet).sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
}

export async function fetchCards(setId) {
  const cards = await getJson(`${API}/sets/${encodeURIComponent(setId)}/cards`);
  return cards.map(normCard);
}

export default { id: 'lorcana', name: 'Disney Lorcana', fetchSets, fetchCards };
