import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrintable } from './printable.js';
import {
  CONDITIONS, GRADERS, artistMatches, copyTotals, isOwned, naturalCompare, normArtist, parseCardRef, resolveVariants, sameNumber,
  sanitizeCollectionRef, sanitizeMatchedCard, setProgress,
} from './collection.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 24 * 60 * 60 * 1000;

export function createApp({ sources, cache, store, printable = {} }) {
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
  // Sources may correct cached cards as they are read (see pokemon.js adjustCard).
  const adjust = (s, cards) => (s.adjustCard ? cards.map(s.adjustCard) : cards);
  const getCards = async (s, setId, refresh) => {
    const cards = await cache.get(`${s.id}-set-${setId}`, () => s.fetchCards(setId), { refresh });
    return [...adjust(s, cards)].sort((a, b) => naturalCompare(a.number, b.number));
  };

  // Cache file for one artist or Pokémon lookup. The same name always maps to the same file.
  const lookupKey = (s, kind, input, suffix = '') => {
    const key = normArtist(input);
    const slug = key.replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    return `${s.id}-${kind}-${slug}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}${suffix}`;
  };

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(502).json({ error: err.message });
    });

  app.get('/api/meta', (req, res) => {
    res.json({
      games: Object.values(sources).map((s) => ({ id: s.id, name: s.name, artists: typeof s.fetchCardsByArtist === 'function', species: typeof s.fetchCardsBySpecies === 'function' })),
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
      const peeked = await cache.peek(`${s.id}-set-${set.id}`);
      const cards = peeked && adjust(s, peeked);
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
      artistOverrides: Object.fromEntries(Object.entries(store.artistOverrides(s.id)).filter(([id]) => cards.some((c) => c.id === id))),
    });
  }));

  // Grayscale 3x3 checklist of the whole set, to print and color in. Cards are in set order.
  app.get('/api/games/:game/sets/:setId/printable.pdf', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const { setId } = req.params;
    const sets = await getSets(s, false);
    const set = sets.find((x) => x.id === setId);
    if (!set) return res.status(404).json({ error: `Unknown set: ${setId}` });
    const cards = await getCards(s, setId, false);
    const { doc, missing } = await buildPrintable(cards, { title: set.name, ...printable });
    const filename = `${set.name.replace(/[^\w.-]+/g, '_')}_printable.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Missing-Images', String(missing.length));
    doc.pipe(res);
  }));

  // Variant rules of every set the cards come from, so the page can edit copies without opening the set.
  const rulesBySet = (s, cards) => Object.fromEntries([...new Set(cards.map((c) => c.setId).filter(Boolean))].map((id) => [id, store.rulesFor(s.id, id)]));

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
    const overrides = store.artistOverrides(s.id);
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
        const artist = overrides[c.id] ?? c.artist;
        if (!(c.id in overrides) && !('artist' in c)) { if (!staleSets.includes(set.name)) staleSets.push(set.name); continue; }
        const key = normArtist(artist);
        if (!key) { noArtist++; continue; }
        const a = byKey.get(key) ?? { name: artist, owned: 0 };
        a.owned++;
        byKey.set(key, a);
      }
    }
    const artists = [...byKey.values()].sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name));
    res.json({ artists, ownedCards: owned.size, notInOpenedSets: owned.size - found.size, noArtist, staleSets });
  }));

  // Every card for one artist: the main database, TCGdex's credits for sets the main one leaves blank, and cards
  // you assigned by hand, merged. The second database is cached separately and allowed to fail, so an outage
  // never hides the main results or gets cached into them. Hand assignments win over both databases.
  // peekOnly: use only what is already cached (null when the main lookup isn't), so the home page never waits.
  async function artistCards(s, name, { refresh = false, peekOnly = false } = {}) {
    const notices = [];
    const dbCards = peekOnly
      ? await cache.peek(lookupKey(s, 'artist', name))
      : await cache.get(lookupKey(s, 'artist', name), () => s.fetchCardsByArtist(name), { maxAgeMs: 7 * DAY, refresh });
    if (!dbCards) return null;
    const cardsOfSet = async (setId) => {
      const cards = peekOnly ? await cache.peek(`${s.id}-set-${setId}`) : await getCards(s, setId, false);
      return cards ? adjust(s, cards) : [];
    };
    // A card another source credits to this artist, filled out with the app's own record of that card (rarity,
    // variants) so it can be marked owned like any other. Falls back to the bare credit if the set has no such card.
    const fillOut = async (cards) => {
      const bySet = new Map();
      for (const c of cards) if (!bySet.has(c.setId)) bySet.set(c.setId, await cardsOfSet(c.setId).catch(() => []));
      return cards.map((c) => {
        const real = bySet.get(c.setId)?.find((x) => x.id === c.id);
        return real ? { ...real, artist: c.artist, setId: c.setId, setName: c.setName, releaseDate: c.releaseDate } : { ...c, variants: ['Normal'] };
      });
    };

    let found = dbCards;
    if (typeof s.fetchSupplementCardsByArtist === 'function') {
      try {
        const sets = peekOnly ? await cache.peek(`${s.id}-sets`) : await getSets(s, refresh);
        const key = lookupKey(s, 'artist-tcgdex', name);
        const extra = peekOnly
          ? await cache.peek(key)
          : await cache.get(key, () => s.fetchSupplementCardsByArtist(name, sets), { maxAgeMs: 7 * DAY, refresh });
        if (extra) {
          const seen = new Set(dbCards.map((c) => c.id));
          found = [...dbCards, ...(await fillOut(extra.cards.filter((c) => !seen.has(c.id))))];
          if (extra.skipped) notices.push(`${extra.skipped} card(s) credited to this artist by TCGdex are in sets this app doesn’t list yet. Use “Refresh from API” here, or “Refresh set list” on the home page.`);
        }
      } catch (err) {
        notices.push(`TCGdex couldn’t be reached (${err.message}). Showing the Pokémon TCG database only, which leaves some recent sets without artists.`);
      }
    }

    const overrides = store.artistOverrides(s.id);
    const merged = found
      .filter((c) => !(c.id in overrides) || artistMatches(overrides[c.id], name))
      .map((c) => (c.id in overrides ? { ...c, artist: overrides[c.id], overridden: true } : c));
    const have = new Set(merged.map((c) => c.id));
    const unresolved = [];
    const assigned = Object.entries(overrides).filter(([id, a]) => !have.has(id) && artistMatches(a, name));
    if (assigned.length) {
      const sets = (peekOnly ? await cache.peek(`${s.id}-sets`) : await getSets(s, false).catch(() => [])) ?? [];
      for (const [id, artist] of assigned) {
        const set = sets.find((x) => x.id === id.slice(0, id.indexOf('-')));
        const card = set && (await cardsOfSet(set.id).catch(() => [])).find((c) => c.id === id);
        if (card) merged.push({ ...card, artist, overridden: true, setId: set.id, setName: set.name, releaseDate: set.releaseDate });
        else unresolved.push(id);
      }
    }
    const cards = adjust(s, merged).sort((a, b) =>
      (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || naturalCompare(a.number, b.number));
    return { cards, notices, unresolved };
  }

  app.get('/api/games/:game/artists/:name', wrap(async (req, res) => {
    const s = artistSource(req, res);
    if (!s) return;
    if (!normArtist(req.params.name)) return res.status(400).json({ error: 'Artist name is required' });
    const { cards, notices, unresolved } = await artistCards(s, req.params.name, { refresh: req.query.refresh === '1' });
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
      notices,
      unresolved,
      cards: cards.map((c) => ({ ...c, owned: isOwned(entries[c.id]), copies: copyTotals(entries[c.id]).copies })),
      entries,
      rules: rulesBySet(s, cards),
    });
  }));

  // Assign cards to an artist by hand. Lines look like "Stellar Crown #91" or "sv7-91".
  app.post('/api/games/:game/artists/:name/cards', wrap(async (req, res) => {
    const s = artistSource(req, res);
    if (!s) return;
    const artist = req.params.name.trim();
    if (!normArtist(artist)) return res.status(400).json({ error: 'Artist name is required' });
    const lines = String(req.body?.cards ?? '').split(/[\n;]/).map((l) => l.trim()).filter(Boolean).slice(0, 500);
    const sets = await getSets(s, false);
    const added = [];
    const unresolved = [];
    const conflicts = [];
    for (const line of lines) {
      const ref = parseCardRef(line);
      let set = null;
      let card = null;
      try {
        if (ref?.id) {
          set = sets.find((x) => x.id === ref.id.slice(0, ref.id.indexOf('-')));
          card = set && (await getCards(s, set.id, false)).find((c) => c.id === ref.id);
        } else if (ref) {
          const q = ref.set.toLowerCase();
          set = sets.find((x) => x.id.toLowerCase() === q) ?? sets.find((x) => x.name.toLowerCase() === q);
          card = set && (await getCards(s, set.id, false)).find((c) => sameNumber(c.number, ref.number));
        }
      } catch (err) {
        unresolved.push({ line, reason: err.message });
        continue;
      }
      if (!card) { unresolved.push({ line, reason: ref ? 'No such set or card number' : 'Not understood' }); continue; }
      if (card.artist && !artistMatches(card.artist, artist)) conflicts.push({ id: card.id, name: card.name, databaseArtist: card.artist });
      added.push({ id: card.id, name: card.name, number: card.number, setName: set.name });
    }
    await store.putArtists(s.id, added.map((c) => c.id), artist);
    res.json({ added, unresolved, conflicts });
  }));

  // Set (or clear, with a blank artist) the artist for one card.
  app.put('/api/games/:game/cards/:cardId/artist', wrap(async (req, res) => {
    const s = artistSource(req, res);
    if (!s) return;
    res.json({ artist: await store.putArtists(s.id, [req.params.cardId], req.body?.artist) });
  }));

  const speciesSource = (req, res) => {
    const s = source(req, res);
    if (s && typeof s.fetchCardsBySpecies !== 'function') {
      res.status(404).json({ error: `${s.name} has no Pokémon lookup` });
      return null;
    }
    return s;
  };

  // One slot per card and variant for one Pokémon. Oldest set first; cards with no dex number (matched by
  // name only) come last. Variants honor each set's rules and each card's hidden/custom variants.
  // peekOnly: use only what is already cached (null if nothing is), so the home page never waits on the API.
  async function speciesSlots(s, input, refresh, peekOnly = false) {
    const key = normArtist(input);
    if (!key) return null;
    const matches = store.speciesMatchesFor(s.id, key) ?? { dex: null, include: [], exclude: [] };
    const cacheKey = lookupKey(s, 'species', input, matches.dex != null ? `-d${matches.dex}` : '');
    const found = peekOnly
      ? await cache.peek(cacheKey)
      : await cache.get(cacheKey, () => s.fetchCardsBySpecies(input, { dex: matches.dex }), { maxAgeMs: 7 * DAY, refresh });
    if (!found) return null;

    // Hand-matched cards count as matched (not "no dex") and show even if the lookup didn't return them.
    const manual = new Map(matches.include.map((c) => [c.id, c]));
    const excluded = new Set(matches.exclude);
    const merged = [];
    const seen = new Set();
    const excludedCards = [];
    for (const c of found) {
      if (excluded.has(c.id)) { excludedCards.push({ id: c.id, name: c.name, number: c.number, setName: c.setName }); continue; }
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(manual.has(c.id) ? { ...c, manual: true } : c);
    }
    for (const c of manual.values()) if (!seen.has(c.id)) merged.push({ ...c, manual: true });
    for (const id of excluded) if (!excludedCards.some((e) => e.id === id)) excludedCards.push({ id });

    const cards = adjust(s, merged).map((c) => ({ ...c, noDex: !c.manual && !c.dex?.length }));
    cards.sort((a, b) =>
      (a.noDex - b.noDex) ||
      (a.releaseDate ?? '9999').localeCompare(b.releaseDate ?? '9999') ||
      (a.setId ?? '').localeCompare(b.setId ?? '') ||
      naturalCompare(a.number, b.number));
    const entries = store.entriesFor(s.id, cards.map((c) => c.id));
    const slots = [];
    for (const { variants, ...card } of cards) {
      for (const variant of resolveVariants({ ...card, variants }, entries[card.id], store.rulesFor(s.id, card.setId))) {
        slots.push({ ...card, cardId: card.id, variant, autoVariants: variants });
      }
    }
    return { slots, entries, matches, excluded: excludedCards, rules: rulesBySet(s, cards) };
  }

  app.get('/api/games/:game/species/:name', wrap(async (req, res) => {
    const s = speciesSource(req, res);
    if (!s) return;
    const data = await speciesSlots(s, req.params.name, req.query.refresh === '1');
    if (!data) return res.status(400).json({ error: 'A Pokémon name or dex number is required' });
    res.json({ species: req.params.name.trim(), ...data });
  }));

  // Replaces this Pokémon's corrections: { dex, include: [card], exclude: [cardId] }.
  app.put('/api/games/:game/species/:name/matches', wrap(async (req, res) => {
    const s = speciesSource(req, res);
    if (!s) return;
    const key = normArtist(req.params.name);
    if (!key) return res.status(400).json({ error: 'A Pokémon name or dex number is required' });
    res.json(await store.putSpeciesMatches(s.id, key, req.body));
  }));

  // Find any card by name, to match it to a Pokémon by hand.
  app.get('/api/games/:game/card-search', wrap(async (req, res) => {
    const s = speciesSource(req, res);
    if (!s) return;
    const found = await s.searchCards(String(req.query.q ?? ''));
    res.json(found.map((c) => sanitizeMatchedCard(c)).filter(Boolean));
  }));

  // Same 3x3 checklist as a set, one slot per variant, labeled with the variant.
  app.get('/api/games/:game/species/:name/printable.pdf', wrap(async (req, res) => {
    const s = speciesSource(req, res);
    if (!s) return;
    const data = await speciesSlots(s, req.params.name, false);
    if (!data) return res.status(400).json({ error: 'A Pokémon name or dex number is required' });
    if (!data.slots.length) return res.status(404).json({ error: `No cards found for ${req.params.name.trim()}` });
    const title = req.params.name.trim();
    const slots = data.slots.map((sl) => ({ id: sl.cardId, number: sl.number, name: sl.name, image: sl.image, imageLarge: sl.imageLarge, label: sl.variant }));
    const { doc, missing } = await buildPrintable(slots, { title, ...printable });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^\w.-]+/g, '_')}_master_set.pdf"`);
    res.setHeader('X-Missing-Images', String(new Set(missing.map((m) => m.id)).size));
    doc.pipe(res);
  }));

  // Saved Pokémon and artist lookups, listed on the home page like sets. Progress comes from cached data only;
  // a lookup that has never loaded has progress null.
  async function collectionProgress(s, c) {
    const total = (cards, variants, ownedVariants) => ({ cards: cards.length, cardsOwned: cards.filter((x) => x.owned).length, variants, variantsOwned: ownedVariants });
    if (c.type === 'species') {
      const data = await speciesSlots(s, c.name, false, true);
      if (!data) return null;
      const byCard = new Map();
      for (const sl of data.slots) {
        const e = data.entries[sl.cardId];
        byCard.set(sl.cardId, { owned: isOwned(e) });
      }
      const p = total([...byCard.values()], data.slots.length, data.slots.filter((sl) => data.entries[sl.cardId]?.variants?.[sl.variant]?.length).length);
      return { ...p, ...sumCopies(byCard.keys(), data.entries) };
    }
    const found = (await artistCards(s, c.name, { peekOnly: true }))?.cards;
    if (!found) return null;
    const entries = store.entriesFor(s.id, found.map((x) => x.id));
    const p = total(found.map((x) => ({ owned: isOwned(entries[x.id]) })), found.length, found.filter((x) => isOwned(entries[x.id])).length);
    return { ...p, ...sumCopies(found.map((x) => x.id), entries) };
  }

  function sumCopies(ids, entries) {
    const t = { copies: 0, value: 0, paid: 0 };
    for (const id of ids) {
      const x = copyTotals(entries[id]);
      t.copies += x.copies; t.value += x.value; t.paid += x.paid;
    }
    return { copies: t.copies, value: Math.round(t.value * 100) / 100, paid: Math.round(t.paid * 100) / 100 };
  }

  app.get('/api/games/:game/collections', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const out = [];
    for (const c of store.collectionsFor(s.id)) out.push({ ...c, progress: await collectionProgress(s, c) });
    res.json(out);
  }));

  app.put('/api/games/:game/collections/:type/:name', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const ref = sanitizeCollectionRef({ type: req.params.type, name: req.params.name });
    if (!ref) return res.status(400).json({ error: 'A saved collection needs a type (species or artist) and a name' });
    const ok = ref.type === 'species' ? typeof s.fetchCardsBySpecies === 'function' : typeof s.fetchCardsByArtist === 'function';
    if (!ok) return res.status(404).json({ error: `${s.name} has no ${ref.type} lookup` });
    res.json(await store.saveCollection(s.id, ref));
  }));

  app.delete('/api/games/:game/collections/:type/:name', wrap(async (req, res) => {
    const s = source(req, res);
    if (!s) return;
    const ref = sanitizeCollectionRef({ type: req.params.type, name: req.params.name });
    if (!ref) return res.status(400).json({ error: 'A saved collection needs a type (species or artist) and a name' });
    res.json(await store.removeCollection(s.id, ref.id));
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
