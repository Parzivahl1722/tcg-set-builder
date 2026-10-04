import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare, resolveVariants, sanitizeCopy, sanitizeEntry, sanitizeRules, setProgress } from '../server/collection.js';

const common = { id: 'a', number: '1', rarity: 'Common', variants: ['Normal', 'Reverse Holo'] };
const ex = { id: 'b', number: '2', rarity: 'Double Rare', variants: ['Holo'] };

test('natural sort handles card numbers', () => {
  assert.deepEqual(['10', '2', '1', 'TG01', '100'].sort(naturalCompare), ['1', '2', '10', '100', 'TG01']);
});

test('resolveVariants applies set rules by rarity, customs, and hides', () => {
  const rules = [{ name: 'Poké Ball Reverse', rarities: ['Common'] }, { name: 'Stamp', rarities: [] }];
  assert.deepEqual(resolveVariants(common, undefined, rules), ['Normal', 'Reverse Holo', 'Poké Ball Reverse', 'Stamp']);
  assert.deepEqual(resolveVariants(ex, undefined, rules), ['Holo', 'Stamp']);
  const entry = { customVariants: ['Error Print', 'Normal'], hiddenVariants: ['Reverse Holo'] };
  assert.deepEqual(resolveVariants(common, entry, []), ['Normal', 'Error Print']);
});

test('sanitizeCopy rejects bad values', () => {
  const c = sanitizeCopy({ id: 'x', condition: 'Mint??', grader: 'Fake', grade: ' 10 ', pricePaid: '-5', value: '12.345', acquired: 'yesterday', notes: 'n'.repeat(900) });
  assert.equal(c.condition, 'NM');
  assert.equal(c.grader, 'Raw');
  assert.equal(c.grade, '10');
  assert.equal(c.pricePaid, null);
  assert.equal(c.value, 12.35);
  assert.equal(c.acquired, '');
  assert.equal(c.notes.length, 500);
});

test('sanitizeEntry drops empty variants and dedupes lists', () => {
  const e = sanitizeEntry({ variants: { Normal: [{}], Holo: [] }, customVariants: ['A', 'A', ''], hiddenVariants: 'nope' });
  assert.deepEqual(Object.keys(e.variants), ['Normal']);
  assert.deepEqual(e.customVariants, ['A']);
  assert.deepEqual(e.hiddenVariants, []);
});

test('sanitizeRules drops nameless rules', () => {
  assert.deepEqual(sanitizeRules([{ name: '' }, { name: 'X', rarities: ['Common'] }, null]), [{ name: 'X', rarities: ['Common'] }]);
  assert.deepEqual(sanitizeRules('bad'), []);
});

test('setProgress counts cards, variants, copies and money', () => {
  const entries = {
    a: { variants: { Normal: [{ value: 1.5, pricePaid: 1 }, { value: 1.5, pricePaid: null }] } },
    b: { variants: { Holo: [{ value: 20, pricePaid: 15 }] } },
  };
  const p = setProgress([common, ex], entries, []);
  assert.deepEqual(p, { cards: 2, cardsOwned: 2, variants: 3, variantsOwned: 2, copies: 3, value: 23, paid: 16 });
  const withRule = setProgress([common, ex], entries, [{ name: 'Poké Ball Reverse', rarities: ['Common'] }]);
  assert.equal(withRule.variants, 4);
});
