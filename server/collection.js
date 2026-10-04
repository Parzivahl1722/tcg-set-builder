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

export function isEmptyEntry(e) {
  return !Object.keys(e.variants).length && !e.customVariants.length && !e.hiddenVariants.length;
}

export function sanitizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((r) => ({ name: str(r?.name, 60), rarities: strList(r?.rarities) }))
    .filter((r) => r.name);
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
