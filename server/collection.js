// Pure collection logic: variant resolution, validation, progress.

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'Other'];

export function cardKey(game, cardId) {
  return `${game}:${cardId}`;
}

export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Auto variants from the data source + set rules + per-card additions, minus hidden ones.
export function resolveVariants(card, entry, rules = []) {
  const out = [...card.variants];
  for (const rule of rules) {
    if (!rule.rarities?.length || rule.rarities.includes(card.rarity)) out.push(rule.name);
  }
  out.push(...(entry?.customVariants ?? []));
  const hidden = new Set(entry?.hiddenVariants ?? []);
  return [...new Set(out)].filter((v) => !hidden.has(v));
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function money(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function sanitizeCopy(c = {}) {
  return {
    id: str(c.id, 40) || Math.random().toString(36).slice(2, 10),
    condition: CONDITIONS.includes(c.condition) ? c.condition : 'NM',
    grader: GRADERS.includes(c.grader) ? c.grader : 'Raw',
    grade: str(c.grade, 10),
    pricePaid: money(c.pricePaid),
    value: money(c.value),
    acquired: /^\d{4}-\d{2}-\d{2}$/.test(c.acquired ?? '') ? c.acquired : '',
    notes: str(c.notes, 500),
  };
}

const strList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 60)).filter(Boolean))] : []);

export function sanitizeEntry(e = {}) {
  const variants = {};
  for (const [name, copies] of Object.entries(e.variants ?? {})) {
    const key = str(name, 60);
    if (key && Array.isArray(copies) && copies.length) variants[key] = copies.slice(0, 999).map(sanitizeCopy);
  }
  return { variants, customVariants: strList(e.customVariants), hiddenVariants: strList(e.hiddenVariants) };
}

const safeUrl = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v.slice(0, 300) : null);
const dexNumber = (v) => (Number.isInteger(v) && v > 0 && v < 10000 ? v : null);

// A card the user matched to a Pokémon by hand, kept whole so it still shows when the API is down.
export function sanitizeMatchedCard(c = {}) {
  const id = str(c.id, 80);
  if (!id) return null;
  return {
    id,
    number: str(c.number, 20),
    name: str(c.name, 100),
    rarity: str(c.rarity, 60) || 'Unknown',
    artist: str(c.artist, 100) || null,
    image: safeUrl(c.image),
    imageLarge: safeUrl(c.imageLarge),
    variants: strList(c.variants),
    setId: str(c.setId, 40) || null,
    setName: str(c.setName, 100) || null,
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(c.releaseDate ?? '') ? c.releaseDate : null,
    supertype: str(c.supertype, 30) || null,
    dex: (Array.isArray(c.dex) ? c.dex : []).map(dexNumber).filter(Boolean).slice(0, 10),
  };
}

// Per-Pokémon corrections: a forced National Dex number, cards matched by hand, and cards removed from the list.
export function sanitizeSpeciesMatches(r = {}) {
  const include = new Map();
  for (const c of (Array.isArray(r.include) ? r.include : []).slice(0, 2000)) {
    const card = sanitizeMatchedCard(c);
    if (card && !include.has(card.id)) include.set(card.id, card);
  }
  const exclude = (Array.isArray(r.exclude) ? [...new Set(r.exclude.map((x) => str(x, 80)).filter(Boolean))] : [])
    .filter((id) => !include.has(id)).slice(0, 2000);
  return { dex: dexNumber(r.dex), include: [...include.values()], exclude };
}

export const COLLECTION_TYPES = ['species', 'artist'];

// A saved lookup shown on the home page like a set: a Pokémon or an artist, by the name the user typed.
export function sanitizeCollectionRef(r = {}) {
  const name = str(r.name, 100);
  const key = normArtist(name);
  if (!COLLECTION_TYPES.includes(r.type) || !key) return null;
  return { id: `${r.type}:${key}`, type: r.type, name };
}

export const isEmptySpeciesMatches = (m) => m.dex == null && !m.include.length && !m.exclude.length;

export function isEmptyEntry(e) {
  return !Object.keys(e.variants).length && !e.customVariants.length && !e.hiddenVariants.length;
}

export function sanitizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((r) => ({ name: str(r?.name, 60), rarities: strList(r?.rarities) }))
    .filter((r) => r.name);
}

// True if any variant has at least one copy (hidden variants still count: the copy is real).
export function isOwned(entry) {
  return Object.values(entry?.variants ?? {}).some((copies) => copies.length > 0);
}

export function copyTotals(entry) {
  const t = { copies: 0, value: 0, paid: 0 };
  for (const copies of Object.values(entry?.variants ?? {})) {
    for (const c of copies) {
      t.copies++;
      t.value += c.value ?? 0;
      t.paid += c.pricePaid ?? 0;
    }
  }
  return t;
}

// Artist names are free text in the card databases: ignore case, accents and spacing when comparing.
export function normArtist(name) {
  return String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function setProgress(cards, entries, rules) {
  const p = { cards: cards.length, cardsOwned: 0, variants: 0, variantsOwned: 0, copies: 0, value: 0, paid: 0 };
  for (const card of cards) {
    const entry = entries[card.id];
    const variants = resolveVariants(card, entry, rules);
    let ownedAny = false;
    p.variants += variants.length;
    for (const v of variants) {
      const copies = entry?.variants?.[v] ?? [];
      if (copies.length) {
        p.variantsOwned++;
        ownedAny = true;
      }
    }
    // Count every copy, including ones under variants that are now hidden.
    for (const copies of Object.values(entry?.variants ?? {})) {
      for (const c of copies) {
        p.copies++;
        p.value += c.value ?? 0;
        p.paid += c.pricePaid ?? 0;
      }
    }
    if (ownedAny) p.cardsOwned++;
  }
  p.value = Math.round(p.value * 100) / 100;
  p.paid = Math.round(p.paid * 100) / 100;
  return p;
}
