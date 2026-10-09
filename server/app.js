import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDITIONS, GRADERS, copyTotals, isOwned, naturalCompare, normArtist, resolveVariants, setProgress } from './collection.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 24 * 60 * 60 * 1000;

export function createApp({ sources, cache, store }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(PUBLIC_DIR));
  // The browser reuses the same variant/progress logic as the server.
  app.get('/lib/collection.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, '..', 'server', 'collection.js')));

  const source = (req, res) => {
    const s = sources[req.params.game];
    if (!s) res.status(404).json({ error: `Unknown game: ${req.params.game}` });
    return s;
  };

  const getSets = (s, refresh) => cache.get(`${s.id}-sets`, () => s.fetchSets(), { maxAgeMs: DAY, refresh });
  const getCards = async (s, setId, refresh) => {
    const cards = await cache.get(`${s.id}-set-${setId}`, () => s.fetchCards(setId), { refresh });
    return [...cards].sort((a, b) => naturalCompare(a.number, b.number));
  };

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(502).json({ error: err.message });
    });

  app.get('/api/meta', (req, res) => {
    res.json({
      games: Object.values(sources).map((s) => ({ id: s.id, name: s.name, artists: typeof s.fetchCardsByArtist === 'function' })),
      conditions: CONDITIONS,
      graders: GRADERS,
    });
  });

  app.get('/api/games/:game/sets', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const sets = await getSets(s, req.query.refresh === '1');
    const out = [];
    for (const set of sets) {
      // Progress only for sets whose cards have been loaded at least once.
      const cards = await cache.peek(`${s.id}-set-${set.id}`);
      let progress = null;
      if (cards) {
        const entries = store.entriesFor(s.id, cards.map((c) => c.id));
        progress = setProgress(cards, entries, store.rulesFor(s.id, set.id));
      }
      out.push({ ...set, progress });
    }
    res.json(out);
  }));

  app.get('/api/games/:game/sets/:setId', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const { setId } = req.params;
    const refresh = req.query.refresh === '1';
    const sets = await getSets(s, false);
    const set = sets.find((x) => x.id === setId);
    if (!set) return res.status(404).json({ error: `Unknown set: ${setId}` });
    const cards = await getCards(s, setId, refresh);
    const rules = store.rulesFor(s.id, setId);
    const entries = store.entriesFor(s.id, cards.map((c) => c.id));
    res.json({
      set,
      rules,
      progress: setProgress(cards, entries, rules),
      cards: cards.map((c) => ({ ...c, autoVariants: c.variants, variants: resolveVariants(c, entries[c.id], rules) })),
      entries,
    });
  }));

  const artistSource = (req, res) => {
    const s = source(req, res);
    if (s && typeof s.fetchCardsByArtist !== 'function') {
      res.status(404).json({ error: `${s.name} has no artist data` });
      return null;
    }
    return s;
  };

  // Artists of the cards you own. Only sets already opened are known, so report what is missing.
  app.get('/api/games/:game/artists', wrap(async (req, res) => {
    const s = artistSource(req, res);
    if (!s) return;
    const owned = store.ownedIds(s.id);
    const sets = (await cache.peek(`${s.id}-sets`)) ?? [];
    const found = new Set();
    const byKey = new Map();
    const staleSets = [];
    let noArtist = 0;
    for (const set of sets) {
      const cards = await cache.peek(`${s.id}-set-${set.id}`);
      for (const c of cards ?? []) {
        if (!owned.has(c.id)) continue;
        found.add(c.id);
        // Cached before artist data was stored: that set needs "Refresh cards" once.
        if (!('artist' in c)) { if (!staleSets.includes(set.name)) staleSets.push(set.name); continue; }
        const key = normArtist(c.artist);
        if (!key) { noArtist++; continue; }
        const a = byKey.get(key) ?? { name: c.artist, owned: 0 };
        a.owned++;
        byKey.set(key, a);
      }
    }
    const artists = [...byKey.values()].sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name));
    res.json({ artists, ownedCards: owned.size, notInOpenedSets: owned.size - found.size, noArtist, staleSets });
  }));

  app.get('/api/games/:game/artists/:name', wrap(async (req, res) => {
    const s = artistSource(req, res);
    if (!s) return;
    const key = normArtist(req.params.name);
    if (!key) return res.status(400).json({ error: 'Artist name is required' });
    const slug = key.replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    const found = await cache.get(`${s.id}-artist-${slug}-${hash}`, () => s.fetchCardsByArtist(req.params.name), {
      maxAgeMs: 7 * DAY, refresh: req.query.refresh === '1',
    });
    const cards = [...found].sort((a, b) =>
      (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || naturalCompare(a.number, b.number));
    const entries = store.entriesFor(s.id, cards.map((c) => c.id));
    const summary = { cards: cards.length, cardsOwned: 0, copies: 0, value: 0, paid: 0 };
    for (const c of cards) {
      const e = entries[c.id];
      if (isOwned(e)) summary.cardsOwned++;
      const t = copyTotals(e);
      summary.copies += t.copies;
      summary.value += t.value;
      summary.paid += t.paid;
    }
    summary.value = Math.round(summary.value * 100) / 100;
    summary.paid = Math.round(summary.paid * 100) / 100;
    res.json({
      artist: req.params.name.trim(),
      summary,
      cards: cards.map((c) => ({ ...c, owned: isOwned(entries[c.id]), copies: copyTotals(entries[c.id]).copies })),
    });
  }));

  app.put('/api/games/:game/cards/:cardId', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    res.json(await store.putEntry(s.id, req.params.cardId, req.body));
  }));

  app.put('/api/games/:game/sets/:setId/rules', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    res.json(await store.putRules(s.id, req.params.setId, req.body));
  }));

  app.get('/api/export', (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="tcg-collection-${date}.json"`);
    res.json(store.raw());
  });

  return app;
}
