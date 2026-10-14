import { getJson } from '../http.js';

// TCGdex (https://tcgdex.dev) is a second community card database. It credits illustrators on sets the
// Pokémon TCG API leaves blank, and carries sets that API lacks (for example the MEP promos).
// This file only fetches; pokemon.js decides how to merge it.
const API = 'https://api.tcgdex.net/v2/en';

// Same ids as the Pokémon TCG API where they overlap: sv03.5 -> sv3pt5, me02 -> me2.
export function normSetId(id) {
  return String(id).toLowerCase().replace(/\.5/g, 'pt5').replace(/([a-z])0+(\d)/g, '$1$2');
}

export const stripZeros = (n) => String(n).replace(/^0+(?=\d)/, '');

// Card ids are "<setId>-<localId>", and local ids can contain letters, so cut off the known suffix.
export const setIdOfCard = (c) => c.id.slice(0, c.id.length - String(c.localId).length - 1);

// Images come back as a base URL with no size or extension.
export const imageUrl = (base, size) => (base ? `${base}/${size}.webp` : null);

export const fetchSetsBrief = () => getJson(`${API}/sets`);
export const fetchSet = (id) => getJson(`${API}/sets/${encodeURIComponent(id)}`);
export const fetchCard = (id) => getJson(`${API}/cards/${encodeURIComponent(id)}`);

export async function fetchPocketSetIds() {
  return new Set((await getJson(`${API}/sets?serie=tcgp`)).map((s) => s.id));
}

// Exact (case-insensitive) illustrator match. Returns brief cards: { id, localId, name, image }.
export async function fetchIllustratorCards(name) {
  try {
    return (await getJson(`${API}/illustrators/${encodeURIComponent(name)}`)).cards ?? [];
  } catch (err) {
    if (/failed: 404/.test(err.message)) return [];
    throw err;
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
