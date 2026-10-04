import fs from 'node:fs/promises';
import path from 'node:path';
import { isEmptyEntry, sanitizeEntry, sanitizeRules } from './collection.js';

// Collection persisted to one JSON file. Writes are serialized and atomic (tmp + rename).
// Shape: { version, cards: { "game:cardId": entry }, setRules: { "game:setId": rules } }
export async function createStore(file) {
  let data = { version: 1, cards: {}, setRules: {} };
  try {
    data = { ...data, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}. Fix or move it before starting.`);
  }

  let queue = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(data, null, 1);
    queue = queue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, file);
    });
    return queue;
  }

  return {
    entriesFor(game, cardIds) {
      const out = {};
      for (const id of cardIds) {
        const e = data.cards[`${game}:${id}`];
        if (e) out[id] = e;
      }
      return out;
    },
    rulesFor(game, setId) {
      return data.setRules[`${game}:${setId}`] ?? [];
    },
    async putEntry(game, cardId, raw) {
      const key = `${game}:${cardId}`;
      const entry = sanitizeEntry(raw);
      if (isEmptyEntry(entry)) delete data.cards[key];
      else data.cards[key] = entry;
      await persist();
      return entry;
    },
    async putRules(game, setId, raw) {
      const key = `${game}:${setId}`;
      const rules = sanitizeRules(raw);
      if (rules.length) data.setRules[key] = rules;
      else delete data.setRules[key];
      await persist();
      return rules;
    },
    raw: () => data,
  };
}
