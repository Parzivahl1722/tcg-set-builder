import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

async function setup(opts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-store-'));
  let day = new Date(2026, 0, 1, 12);
  const store = await createStore(path.join(dir, 'collection.json'), { now: () => day, ...opts });
  const backups = async () => (await fs.readdir(path.join(dir, 'backups')).catch(() => [])).sort();
  const read = async (f) => JSON.parse(await fs.readFile(path.join(dir, 'backups', f), 'utf8'));
  return { dir, store, backups, read, setDay: (d) => { day = d; } };
}

test('first write creates no backup because there is no file yet', async () => {
  const { store, backups } = await setup();
  await store.putEntry('pokemon', 'a', { variants: { Normal: [{}] } });
  assert.deepEqual(await backups(), []);
});

test('backs up the pre-change file once per day', async () => {
  const { store, backups, read, setDay } = await setup();
  await store.putEntry('pokemon', 'a', { variants: { Normal: [{}] } });
  setDay(new Date(2026, 0, 2, 9));
  await store.putEntry('pokemon', 'b', { variants: { Normal: [{}] } });
  await store.putEntry('pokemon', 'c', { variants: { Normal: [{}] } });
  assert.deepEqual(await backups(), ['collection-2026-01-02.json']);
  // The backup is the collection as it was before that day's edits.
  assert.deepEqual(Object.keys((await read('collection-2026-01-02.json')).cards), ['pokemon:a']);
});

test('keeps only the newest N backups', async () => {
  const { store, backups, setDay } = await setup({ backupKeep: 3 });
  for (let d = 1; d <= 6; d++) {
    setDay(new Date(2026, 0, d, 12));
    await store.putEntry('pokemon', `card${d}`, { variants: { Normal: [{}] } });
  }
  assert.deepEqual(await backups(), ['collection-2026-01-04.json', 'collection-2026-01-05.json', 'collection-2026-01-06.json']);
});

test('backupKeep 0 disables backups', async () => {
  const { store, backups, setDay } = await setup({ backupKeep: 0 });
  await store.putEntry('pokemon', 'a', { variants: { Normal: [{}] } });
  setDay(new Date(2026, 0, 2));
  await store.putEntry('pokemon', 'b', { variants: { Normal: [{}] } });
  assert.deepEqual(await backups(), []);
});

test('a failed write does not block later saves', async () => {
  const { dir, store } = await setup();
  const file = path.join(dir, 'collection.json');
  await fs.mkdir(`${file}.tmp`); // writing the temp file now fails with EISDIR
  await assert.rejects(store.putEntry('pokemon', 'a', { variants: { Normal: [{}] } }));
  await fs.rm(`${file}.tmp`, { recursive: true });
  await store.putEntry('pokemon', 'b', { variants: { Normal: [{}] } });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(saved.cards['pokemon:b']);
});

test('artist overrides persist, are per game, and clear on a blank name', async () => {
  const { dir, store } = await setup();
  await store.putArtists('pokemon', ['sv7-91', 'sv8-73'], '  Shimaris Yukichi ');
  await store.putArtists('lorcana', ['x-1'], 'Someone');
  assert.deepEqual(store.artistOverrides('pokemon'), { 'sv7-91': 'Shimaris Yukichi', 'sv8-73': 'Shimaris Yukichi' });
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'collection.json'), 'utf8'));
  assert.equal(saved.artistOverrides['pokemon:sv7-91'], 'Shimaris Yukichi');

  await store.putArtists('pokemon', ['sv7-91'], '');
  assert.deepEqual(Object.keys(store.artistOverrides('pokemon')), ['sv8-73']);

  // A collection file written before overrides existed still loads.
  await fs.writeFile(path.join(dir, 'old.json'), JSON.stringify({ version: 1, cards: {}, setRules: {} }));
  const old = await createStore(path.join(dir, 'old.json'));
  assert.deepEqual(old.artistOverrides('pokemon'), {});
});
