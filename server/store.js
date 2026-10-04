import fs from 'node:fs/promises';
import path from 'node:path';
import { isEmptyEntry, sanitizeEntry, sanitizeRules } from './collection.js';

// Collection persisted to one JSON file. Writes are serialized and atomic (tmp + rename).
// Shape: { version, cards: { "game:cardId": entry }, setRules: { "game:setId": rules } }
//
// Before the first write of each day, the current file is copied to backups/collection-YYYY-MM-DD.json,
// so any day's changes can be rolled back. The newest `backupKeep` backups are kept (0 disables).
export async function createStore(file, { backupKeep = 30, now = () => new Date() } = {}) {
  const backupDir = path.join(path.dirname(file), 'backups');

  async function dailyBackup() {
    if (backupKeep <= 0) return;
    const d = now();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const target = path.join(backupDir, `collection-${day}.json`);
    try {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EEXIST') return; // nothing to back up yet, or already done today
      throw err;
    }
    const old = (await fs.readdir(backupDir)).filter((f) => /^collection-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -backupKeep);
    await Promise.all(old.map((f) => fs.rm(path.join(backupDir, f))));
  }

  let data = { version: 1, cards: {}, setRules: {} };
  try {
    data = { ...data, ...JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}. Fix or move it before starting.`);
  }

  let queue = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(data, null, 1);
    // catch() so one failed write doesn't block every later save.
    queue = queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await dailyBackup().catch((err) => console.warn(`[backup] failed: ${err.message}`));
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
