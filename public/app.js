import { copyTotals, isOwned, normArtist, resolveVariants, setProgress } from '/lib/collection.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const modal = $('#modal');
const modalBody = $('#modal-body');

const state = {
  meta: null,
  game: 'pokemon',
  sets: {}, // game -> list
  collections: {}, // game -> saved Pokémon/artist lookups, with progress
  setsQuery: '',
  startedOnly: false,
  current: null, // { game, set, cards, entries, rules }
  filter: 'all',
  query: '',
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isError ? 6000 : 2500);
}

const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function cardImage(card, large = false) {
  const src = large ? card.imageLarge || card.image : card.image;
  const fallback = () => h('div', { class: 'placeholder' }, h('strong', {}, `#${card.number}`), h('span', {}, card.name));
  if (!src) return fallback();
  const img = h('img', { src, alt: `${card.name} #${card.number}`, loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function progressBar(owned, total, label) {
  return h('div', { class: 'progress' },
    h('div', { class: 'progress-label' }, h('span', {}, label), h('span', {}, `${owned}/${total} · ${pct(owned, total)}%`)),
    h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${pct(owned, total)}%` })),
  );
}

// ---------- routing ----------

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (!state.meta) state.meta = await api('/api/meta');
  if (parts[0] === 'game' && parts[1]) state.game = parts[1];
  renderTabs();
  modal.close();
  try {
    if (parts[0] === 'game' && parts[2] === 'set' && parts[3]) await showSet(parts[1], parts[3]);
    else if (parts[0] === 'game' && parts[2] === 'artists') await showArtists(parts[1]);
    else if (parts[0] === 'game' && parts[2] === 'artist' && parts[3]) await showArtist(parts[1], parts[3]);
    else if (parts[0] === 'game' && parts[2] === 'species' && parts[3]) await showSpecies(parts[1], parts[3]);
    else if (parts[0] === 'game' && parts[2] === 'species') showSpeciesSearch(parts[1]);
    else await showHome(state.game);
  } catch (err) {
    view.replaceChildren(h('div', { class: 'error-box' },
      h('h2', {}, 'Could not load data'),
      h('p', {}, err.message),
      h('p', {}, 'If this is the first time loading this set, the card API may be down. Try again in a minute.'),
    ));
  }
}

function renderTabs() {
  $('#game-tabs').replaceChildren(...state.meta.games.map((g) =>
    h('a', { href: `#/game/${g.id}`, class: g.id === state.game ? 'active' : null }, g.name)));
}

// ---------- home: list of sets ----------

async function showHome(game, refresh = false) {
  view.replaceChildren(h('p', { class: 'loading' }, 'Loading sets…'));
  if (refresh || !state.sets[game]) state.sets[game] = await api(`/api/games/${game}/sets${refresh ? '?refresh=1' : ''}`);
  if (!state.collections[game]) state.collections[game] = await api(`/api/games/${game}/collections`);
  renderHome(game);
}

function renderHome(game) {
  const q = state.setsQuery.toLowerCase();
  const sets = state.sets[game].filter((s) =>
    (!q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.series ?? '').toLowerCase().includes(q)) &&
    (!state.startedOnly || s.progress?.copies));

  const groups = new Map();
  for (const s of sets) {
    const key = s.series || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const search = h('input', {
    type: 'search', placeholder: 'Search sets…', value: state.setsQuery,
    oninput: (e) => { state.setsQuery = e.target.value; renderHomeList(); },
  });

  const list = h('div', { class: 'set-groups' });
  const saved = (state.collections[game] ?? []).filter((c) =>
    (!q || c.name.toLowerCase().includes(q) || 'saved collections'.includes(q)) && (!state.startedOnly || c.progress?.copies));
  if (saved.length) {
    list.append(h('section', { class: 'set-group' },
      h('h2', {}, 'My collections'),
      h('div', { class: 'set-list' }, saved.map((c) => {
        const p = c.progress;
        const label = c.type === 'species' ? 'Master set' : 'Cards';
        return h('div', { class: 'set-row-wrap' },
          h('a', { class: 'set-row', href: `#/game/${game}/${c.type === 'species' ? 'species' : 'artist'}/${encodeURIComponent(c.name)}` },
            h('div', { class: 'set-logo' }, h('span', {}, c.type === 'species' ? '★' : '✎')),
            h('div', { class: 'set-info' },
              h('div', { class: 'set-name' }, collectionTitle(c)),
              h('div', { class: 'set-sub' }, `${c.type === 'species' ? 'Pokémon' : 'Artist'}${p ? ` · ${p.cards} cards` : ''}`),
              p ? progressBar(p.variantsOwned, p.variants, label) : h('div', { class: 'set-sub muted' }, 'Not opened yet'))),
          h('button', { class: 'ghost small row-remove', title: 'Remove from home (your cards stay)', 'aria-label': `Remove ${c.name}`,
            onclick: () => toggleSaved(game, c.type, c.name, true).then(() => showHome(game)).catch((e) => toast(e.message, true)) }, '✕'));
      }))));
  }
  function renderHomeList() {
    const keep = document.activeElement === search;
    renderHome(game);
    if (keep) { const s = $('.toolbar input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  for (const [series, items] of groups) {
    list.append(h('section', { class: 'set-group' },
      h('h2', {}, series),
      h('div', { class: 'set-list' }, items.map((s) => {
        const p = s.progress;
        return h('a', { class: 'set-row', href: `#/game/${game}/set/${encodeURIComponent(s.id)}` },
          h('div', { class: 'set-logo' }, s.logo ? h('img', { src: s.logo, alt: '', loading: 'lazy' }) : h('span', {}, s.name.slice(0, 2))),
          h('div', { class: 'set-info' },
            h('div', { class: 'set-name' }, s.name),
            h('div', { class: 'set-sub' }, [s.releaseDate, s.total ? `${s.total} cards` : null].filter(Boolean).join(' · ')),
            p ? progressBar(p.variantsOwned, p.variants, 'Master set') : h('div', { class: 'set-sub muted' }, 'Not opened yet'),
          ),
        );
      })),
    ));
  }
  if (!sets.length) list.append(h('p', { class: 'muted' }, 'No sets match.'));

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      search,
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.startedOnly, onchange: (e) => { state.startedOnly = e.target.checked; renderHome(game); } }),
        'Only sets I’ve started'),
      h('button', { class: 'ghost', onclick: () => showHome(game, true).catch((e) => toast(e.message, true)) }, 'Refresh set list'),
      state.meta.games.find((g) => g.id === game)?.artists ? h('a', { class: 'button-link', href: `#/game/${game}/artists` }, 'By artist') : null,
      state.meta.games.find((g) => g.id === game)?.species ? h('a', { class: 'button-link', href: `#/game/${game}/species` }, 'By Pokémon') : null,
    ),
    list,
  );
}

// ---------- saved collections ----------

const collectionTitle = (c) => (c.type === 'species' && /^#?\d+$/.test(c.name) ? `Pokédex #${c.name.replace('#', '')}` : c.name);

async function isSaved(game, type, name) {
  const id = `${type}:${normArtist(name)}`;
  return (await api(`/api/games/${game}/collections`)).some((c) => c.id === id);
}

async function toggleSaved(game, type, name, currentlySaved) {
  await api(`/api/games/${game}/collections/${type}/${encodeURIComponent(name)}`, { method: currentlySaved ? 'DELETE' : 'PUT' });
  state.collections[game] = null;
}

// Star button: saves this lookup to the home page list, or removes it.
function saveButton(game, type, name, saved) {
  const btn = h('button', { class: 'ghost' });
  const paint = () => {
    btn.textContent = saved ? '★ Saved to home' : '☆ Save to home';
    btn.title = saved ? 'Click to remove it from the home page' : 'Show this on the home page like a set';
  };
  paint();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await toggleSaved(game, type, name, saved);
      saved = !saved;
      if (type === 'species') speciesView.saved = saved; else artistView.saved = saved;
      paint();
      toast(saved ? 'Saved to the home page' : 'Removed from the home page');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// ---------- artists ----------

// replaceChildren would print "null" for an omitted section.
const show = (...nodes) => view.replaceChildren(...nodes.filter(Boolean));

async function showArtists(game) {
  view.replaceChildren(h('p', { class: 'loading' }, 'Loading artists…'));
  const data = await api(`/api/games/${game}/artists`);
  const input = h('input', { type: 'search', placeholder: 'Artist name, e.g. Yuka Morii', list: 'artist-names', autofocus: true });
  const go = () => { const n = input.value.trim(); if (n) location.hash = `#/game/${game}/artist/${encodeURIComponent(n)}`; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const gaps = [
    data.staleSets.length ? `${data.staleSets.length} opened set(s) were saved before artist data existed (${data.staleSets.slice(0, 5).join(', ')}${data.staleSets.length > 5 ? '…' : ''}). Use “Refresh cards” on each to include them.` : null,
    data.notInOpenedSets ? `${data.notInOpenedSets} owned card(s) are in sets you haven’t opened, so their artists aren’t listed.` : null,
    data.noArtist ? `${data.noArtist} owned card(s) have no artist in the database.` : null,
  ].filter(Boolean);
  show(
    h('a', { href: `#/game/${game}`, class: 'back' }, '← All sets'),
    h('h1', {}, 'Collection by artist'),
    h('div', { class: 'toolbar' }, input, h('button', { onclick: go }, 'Look up')),
    h('datalist', { id: 'artist-names' }, data.artists.map((a) => h('option', { value: a.name }))),
    gaps.length ? h('div', { class: 'notice' }, gaps.map((g) => h('p', {}, g))) : null,
    data.artists.length
      ? h('div', { class: 'set-list' }, data.artists.map((a) => h('a', { class: 'set-row', href: `#/game/${game}/artist/${encodeURIComponent(a.name)}` },
          h('div', { class: 'set-info' }, h('div', { class: 'set-name' }, a.name), h('div', { class: 'set-sub' }, `${a.owned} owned`)))))
      : h('p', { class: 'muted' }, 'No artists yet. Type a name above, or open sets and mark cards as owned.'),
  );
}

const artistView = { filter: 'all', game: null, name: null, data: null, saved: false, notice: [] };

// The databases leave some artist credits blank. This assigns cards to an artist by hand, and lists the
// assignments already made so they can be undone.
function addCardsPanel(game, name, artist, assigned) {
  const box = h('textarea', { rows: 5, placeholder: 'One per line, e.g.\nStellar Crown #91\nSurging Sparks 73\nsv7-91' });
  const submit = async () => {
    if (!box.value.trim()) return;
    try {
      const r = await api(`/api/games/${game}/artists/${encodeURIComponent(name)}/cards`, { method: 'POST', body: JSON.stringify({ cards: box.value }) });
      artistView.notice = [
        r.added.length ? `Added ${r.added.length}: ${r.added.map((c) => `${c.name} (${c.setName} #${c.number})`).join(', ')}.` : null,
        ...r.conflicts.map((c) => `${c.name} (${c.id}) is credited to ${c.databaseArtist} in the database. Your assignment overrides it.`),
        ...r.unresolved.map((u) => `Couldn’t add “${u.line}”: ${u.reason}.`),
      ].filter(Boolean);
      await showArtist(game, name);
    } catch (err) { toast(err.message, true); }
  };
  return h('details', { class: 'add-cards' },
    h('summary', {}, `Add cards the databases don’t credit to ${artist}${assigned.length ? ` (${assigned.length} added by you)` : ''}`),
    h('p', { class: 'muted' }, 'Check the printed illustrator credit on the card before adding. Matches the set by name or id, then the card number.'),
    box,
    h('div', { class: 'row' }, h('button', { onclick: submit }, 'Add to this artist')),
    assigned.length ? h('ul', { class: 'assigned' }, assigned.map((c) => h('li', {},
      `${c.name} · ${c.setName ?? c.setId} #${c.number} `,
      h('button', { class: 'link', title: 'Stop assigning this card to this artist',
        onclick: () => setCardArtist(game, c.id, '').then(() => showArtist(game, name)).catch((e) => toast(e.message, true)) }, 'remove')))) : null,
  );
}

async function setCardArtist(game, cardId, artist) {
  return api(`/api/games/${game}/cards/${encodeURIComponent(cardId)}/artist`, { method: 'PUT', body: JSON.stringify({ artist }) });
}

async function showArtist(game, name, refresh = false) {
  view.replaceChildren(h('p', { class: 'loading' }, `Looking up ${name}… (first lookup can take a minute)`));
  const data = await api(`/api/games/${game}/artists/${encodeURIComponent(name)}${refresh ? '?refresh=1' : ''}`);
  data.cards = data.cards.map((c) => ({ ...c, autoVariants: c.variants ?? [] }));
  const artistName = data.cards.find((c) => c.artist?.toLowerCase() === data.artist.toLowerCase())?.artist ?? data.artist;
  if (artistView.name !== name) artistView.notice = [];
  Object.assign(artistView, { game, name, data, artistName, saved: await isSaved(game, 'artist', artistName) });
  ext = {
    game, entries: data.entries, rulesFor: (card) => data.rules[card.setId] ?? [], redraw: renderArtist,
    // Assigning or clearing a card's artist changes which cards belong here, so reload the page.
    onArtistChange: () => { modal.close(); showArtist(game, name).catch((e) => toast(e.message, true)); },
  };
  renderArtist();
}

function renderArtist() {
  const { game, name, data, artistName, saved } = artistView;
  const y = window.scrollY;
  const owned = (c) => isOwned(data.entries[c.id]);
  const sm = { cards: data.cards.length, cardsOwned: data.cards.filter(owned).length, copies: 0, value: 0, paid: 0 };
  for (const c of data.cards) {
    const t = copyTotals(data.entries[c.id]);
    sm.copies += t.copies; sm.value += t.value; sm.paid += t.paid;
  }
  const shown = data.cards.filter((c) => artistView.filter === 'all' || (artistView.filter === 'owned') === owned(c));
  const bySet = new Map();
  for (const c of shown) {
    const key = c.setId ?? 'unknown';
    if (!bySet.has(key)) bySet.set(key, { name: c.setName ?? 'Unknown set', date: c.releaseDate, id: c.setId, cards: [] });
    bySet.get(key).cards.push(c);
  }
  const filters = [['all', 'All'], ['owned', 'Owned'], ['missing', 'Missing']];
  show(
    h('div', { class: 'set-header' },
      h('a', { href: `#/game/${game}/artists`, class: 'back' }, '← Artists'),
      h('h1', {}, artistName),
      sm.cards
        ? h('div', { class: 'stats' },
            progressBar(sm.cardsOwned, sm.cards, 'Cards owned'),
            h('div', { class: 'stat-line' }, h('span', {}, `${sm.copies} copies`), h('span', {}, `Paid ${money(Math.round(sm.paid * 100) / 100)}`), h('span', {}, `Value ${money(Math.round(sm.value * 100) / 100)}`)))
        : h('p', { class: 'muted' }, 'No cards found for that name. Check the spelling, or try a shorter form.'),
    ),
    h('div', { class: 'toolbar' },
      h('div', { class: 'segmented' }, filters.map(([id, label]) =>
        h('button', { class: artistView.filter === id ? 'active' : null, onclick: () => { artistView.filter = id; renderArtist(); } }, label))),
      sm.cards ? saveButton(game, 'artist', artistName, saved) : null,
      h('button', { class: 'ghost', onclick: () => showArtist(game, name, true).then(() => toast('Artist data refreshed')).catch((e) => toast(e.message, true)) }, 'Refresh from API'),
    ),
    artistView.notice.length || data.notices?.length ? h('div', { class: 'notice' }, [...artistView.notice, ...(data.notices ?? [])].map((n) => h('p', {}, n))) : null,
    data.unresolved?.length ? h('div', { class: 'notice' }, h('p', {}, `${data.unresolved.length} card(s) you assigned here couldn’t be loaded right now: ${data.unresolved.join(', ')}.`)) : null,
    addCardsPanel(game, name, artistName, data.cards.filter((c) => c.overridden)),
    ...[...bySet.values()].map((g) => h('section', { class: 'set-group' },
      h('h2', {}, g.id ? h('a', { href: `#/game/${game}/set/${encodeURIComponent(g.id)}` }, g.name) : g.name, g.date ? h('span', { class: 'muted' }, ` · ${g.date}`) : null),
      h('div', { class: 'grid' }, g.cards.map(tile)),
    )),
  );
  window.scrollTo(0, y);
}

// ---------- by Pokémon: one slot per card and variant ----------

function showSpeciesSearch(game) {
  const input = h('input', { type: 'search', placeholder: 'Pokémon name or dex number, e.g. Pikachu or 25', autofocus: true });
  const go = () => { const n = input.value.trim(); if (n) location.hash = `#/game/${game}/species/${encodeURIComponent(n)}`; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  view.replaceChildren(
    h('a', { href: `#/game/${game}`, class: 'back' }, '← All sets'),
    h('h1', {}, 'Master set by Pokémon'),
    h('div', { class: 'toolbar' }, input, h('button', { onclick: go }, 'Look up')),
    h('p', { class: 'muted' }, 'Lists every printing of every card of one Pokémon, oldest set first, with one slot per variant (Normal, Reverse Holo…). Cards the database has no Pokédex number for are included when their name matches, listed last.'),
  );
}

const speciesView = { filter: 'all', game: null, name: null, data: null };

async function showSpecies(game, name, refresh = false) {
  if (!refresh && speciesView.data && speciesView.game === game && speciesView.name === name) {
    ext = { game, entries: speciesView.data.entries, rulesFor: (card) => speciesView.data.rules[card.setId] ?? [], dirty: false,
      redraw: () => { const y = window.scrollY; renderSpecies(); window.scrollTo(0, y); }, onClose: () => { speciesView.data = null; showSpecies(game, name).catch((e) => toast(e.message, true)); } };
    return renderSpecies();
  }
  view.replaceChildren(h('p', { class: 'loading' }, `Looking up ${name}… (first lookup can take a minute)`));
  const data = await api(`/api/games/${game}/species/${encodeURIComponent(name)}${refresh ? '?refresh=1' : ''}`);
  Object.assign(speciesView, { game, name, data, saved: await isSaved(game, 'species', name) });
  ext = {
    game, entries: data.entries, rulesFor: (card) => data.rules[card.setId] ?? [], dirty: false,
    redraw: () => { const y = window.scrollY; renderSpecies(); window.scrollTo(0, y); },
    onClose: () => { speciesView.data = null; const y = window.scrollY; showSpecies(game, name).then(() => window.scrollTo(0, y)).catch((e) => toast(e.message, true)); },
  };
  renderSpecies();
}

const slotCopies = (slot) => speciesView.data.entries[slot.cardId]?.variants?.[slot.variant] ?? [];

// Click a slot: add a plain copy if you own none; remove a lone untouched copy; otherwise open the card's
// details (condition, grade, price) here, so a misclick can't wipe a copy you've recorded details for.
function toggleSlot(slot) {
  const copies = slotCopies(slot);
  if (copies.length && !(copies.length === 1 && isPlain(copies[0]))) return openCard(slot);
  return saveEntry(slot, (e) => {
    if (copies.length) e.variants[slot.variant] = [];
    else (e.variants[slot.variant] ??= []).push(newCopy());
  });
}

// Corrections for this Pokémon (forced dex, hand-matched cards, removed cards) are saved server-side, then the page reloads.
async function saveMatches(change) {
  const { game, name, data } = speciesView;
  const next = { ...structuredClone(data.matches), ...change };
  const scroll = window.scrollY;
  try {
    await api(`/api/games/${game}/species/${encodeURIComponent(name)}/matches`, { method: 'PUT', body: JSON.stringify(next) });
    speciesView.data = null;
    await showSpecies(game, name);
    window.scrollTo(0, scroll);
  } catch (err) {
    toast(`Not saved: ${err.message}`, true);
  }
}

// What a hand-matched card keeps: the card itself, not the per-variant slot fields.
const cardOf = (sl) => ({ id: sl.cardId, number: sl.number, name: sl.name, rarity: sl.rarity, artist: sl.artist, image: sl.image, imageLarge: sl.imageLarge,
  variants: speciesView.data.slots.filter((x) => x.cardId === sl.cardId).map((x) => x.variant), setId: sl.setId, setName: sl.setName, releaseDate: sl.releaseDate,
  supertype: sl.supertype, dex: sl.dex });
const matchCard = (card) => saveMatches({ include: [...speciesView.data.matches.include.filter((c) => c.id !== card.id), card], exclude: speciesView.data.matches.exclude.filter((id) => id !== card.id) });
const unmatchCard = (id) => saveMatches({ include: speciesView.data.matches.include.filter((c) => c.id !== id) });
const excludeCard = (id) => saveMatches({ include: speciesView.data.matches.include.filter((c) => c.id !== id), exclude: [...new Set([...speciesView.data.matches.exclude, id])] });
const restoreCard = (id) => saveMatches({ exclude: speciesView.data.matches.exclude.filter((x) => x !== id) });

// The dex number the lookup settled on: the most common single-species number among the cards.
function autoDex(slots) {
  const votes = new Map();
  for (const sl of slots) if (sl.dex?.length === 1) votes.set(sl.dex[0], (votes.get(sl.dex[0]) ?? 0) + 1);
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function matchPanel() {
  const { game, data } = speciesView;
  const results = h('div', { class: 'search-results' });
  const input = h('input', { type: 'search', placeholder: 'Search any card by name, e.g. Pikachu Libre' });
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    results.replaceChildren(h('p', { class: 'loading' }, 'Searching…'));
    try {
      const found = await api(`/api/games/${game}/card-search?q=${encodeURIComponent(q)}`);
      const have = new Set(data.slots.map((sl) => sl.cardId));
      results.replaceChildren(...(found.length ? [h('div', { class: 'grid' }, found.map((c) => h('div', { class: 'tile' },
        h('div', { class: 'art' }, cardImage(c)),
        h('div', { class: 'meta' }, h('span', { class: 'num' }, `#${c.number}`), h('span', { class: 'name', title: c.name }, c.name)),
        h('div', { class: 'set-sub' }, `${c.setName ?? ''}${c.releaseDate ? ` · ${c.releaseDate.slice(0, 4)}` : ''}`),
        have.has(c.id) ? h('div', { class: 'set-sub' }, 'Already listed') : h('button', { class: 'small', onclick: () => matchCard(c) }, 'Match to this Pokémon'))))]
        : [h('p', { class: 'muted' }, 'No cards found.')]));
    } catch (err) {
      results.replaceChildren(h('p', { class: 'error-text' }, err.message));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  return h('details', { class: 'match-panel' },
    h('summary', {}, 'Match a card by hand'),
    h('div', { class: 'toolbar' }, input, h('button', { onclick: search }, 'Search')),
    results);
}

async function downloadSpeciesPdf(e) {
  const btn = e.currentTarget;
  const { game, name } = speciesView;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const res = await fetch(`/api/games/${game}/species/${encodeURIComponent(name)}/printable.pdf`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
    const url = URL.createObjectURL(await res.blob());
    h('a', { href: url, download: `${name.replace(/[^\w.-]+/g, '_')}_master_set.pdf` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const missing = Number(res.headers.get('X-Missing-Images'));
    toast(missing ? `PDF saved, but ${missing} card image(s) could not be loaded and are blank boxes` : 'PDF saved', !!missing);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Printable PDF';
  }
}

function renderSpecies() {
  const { game, name, data } = speciesView;
  const slots = data.slots;
  const owned = (sl) => slotCopies(sl).length > 0;
  const cardIds = [...new Set(slots.map((sl) => sl.cardId))];
  const totals = { copies: 0, value: 0, paid: 0 };
  for (const id of cardIds) {
    const t = copyTotals(data.entries[id]);
    totals.copies += t.copies; totals.value += t.value; totals.paid += t.paid;
  }
  const cardsOwned = cardIds.filter((id) => isOwned(data.entries[id])).length;
  const noDex = slots.filter((sl) => sl.noDex);
  const shown = slots.filter((sl) => speciesView.filter === 'all' || (speciesView.filter === 'owned') === owned(sl));

  const groups = new Map();
  for (const sl of shown) {
    const key = sl.noDex ? 'nodex' : sl.setId ?? 'unknown';
    if (!groups.has(key)) groups.set(key, { noDex: sl.noDex, id: sl.setId, name: sl.setName ?? 'Unknown set', date: sl.releaseDate, slots: [] });
    groups.get(key).slots.push(sl);
  }
  const filters = [['all', 'All'], ['owned', 'Owned'], ['missing', 'Missing']];
  const redraw = (f) => { speciesView.filter = f; renderSpecies(); };
  const numericInput = /^#?\d+$/.test(data.species);
  const dexInput = h('input', { type: 'number', min: 1, max: 9999, value: data.matches.dex ?? '', placeholder: autoDex(slots) ? `auto: ${autoDex(slots)}` : 'none found', 'aria-label': 'National Dex number' });
  const saveDex = () => saveMatches({ dex: dexInput.value === '' ? null : Number(dexInput.value) });
  dexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDex(); });
  const firstSlots = new Set();

  view.replaceChildren(
    h('div', { class: 'set-header' },
      h('a', { href: `#/game/${game}/species`, class: 'back' }, '← Pokémon'),
      h('h1', {}, /^#?\d+$/.test(data.species) ? `Pokédex #${data.species.replace('#', '')}` : data.species),
      slots.length
        ? h('div', { class: 'stats' },
            progressBar(slots.filter(owned).length, slots.length, 'Master set (every variant)'),
            progressBar(cardsOwned, cardIds.length, 'Cards (any version)'),
            h('div', { class: 'stat-line' }, h('span', {}, `${totals.copies} copies`), h('span', {}, `Paid ${money(Math.round(totals.paid * 100) / 100)}`), h('span', {}, `Value ${money(Math.round(totals.value * 100) / 100)}`)))
        : h('p', { class: 'muted' }, 'No cards found. Check the spelling, or enter the National Dex number.'),
    ),
    h('div', { class: 'toolbar' },
      h('div', { class: 'segmented' }, filters.map(([id, label]) =>
        h('button', { class: speciesView.filter === id ? 'active' : null, onclick: () => redraw(id) }, label))),
      !numericInput ? h('label', { class: 'dex-override', title: 'Wrong Pokémon? Force the National Dex number. Clear it to go back to automatic.' },
        'Dex #', dexInput, h('button', { class: 'small', onclick: saveDex }, 'Set')) : null,
      slots.length ? saveButton(game, 'species', name, speciesView.saved) : null,
      slots.length ? h('button', { class: 'ghost', onclick: downloadSpeciesPdf }, 'Printable PDF') : null,
      h('button', { class: 'ghost', onclick: () => showSpecies(game, name, true).then(() => toast('Pokémon data refreshed')).catch((e) => toast(e.message, true)) }, 'Refresh from API'),
    ),
    ...(noDex.length ? [h('div', { class: 'notice' }, h('p', {},
      `${new Set(noDex.map((sl) => sl.cardId)).size} card(s) have no Pokédex number in the database and are included because their name matches. They are listed last and printed last. Use Match to confirm one (it moves into the list by date) or Remove if it isn't this Pokémon.`))] : []),
    ...(data.excluded.length ? [h('div', { class: 'notice' }, h('p', {}, 'Removed from this Pokémon: ',
      data.excluded.map((c) => h('button', { class: 'link', title: 'Put it back', onclick: () => restoreCard(c.id) }, `${c.name ?? c.id}${c.setName ? ` (${c.setName})` : ''} · restore`))))] : []),
    matchPanel(),
    ...[...groups.values()].map((g) => h('section', { class: 'set-group' },
      h('h2', {}, g.noDex ? 'No Pokédex number (name match)' : g.id ? h('a', { href: `#/game/${game}/set/${encodeURIComponent(g.id)}` }, g.name) : g.name,
        g.date && !g.noDex ? h('span', { class: 'muted' }, ` · ${g.date}`) : null),
      h('div', { class: 'grid' }, g.slots.map((sl) => {
        const n = slotCopies(sl).length;
        return h('div', { class: `tile ${n ? 'complete' : 'missing'}` },
          h('button', { class: 'art', title: n ? 'Click to unmark (or open details)' : 'Click to mark as owned', onclick: () => toggleSlot(sl) },
            cardImage(sl), n ? h('span', { class: 'badge' }, n > 1 ? `×${n}` : '✓') : null),
          h('div', { class: 'meta' }, h('span', { class: 'num' }, `#${sl.number}`), h('span', { class: 'name', title: sl.name }, sl.name),
            h('button', { class: 'info', title: 'Details, condition, grade, price', onclick: () => openCard(sl) }, '⋯')),
          h('div', { class: 'set-sub' }, g.noDex ? `${sl.setName ?? ''} · ${sl.variant}` : sl.variant),
          (() => {
            if (firstSlots.has(sl.cardId)) return null;
            firstSlots.add(sl.cardId);
            if (sl.noDex) return h('div', { class: 'row' },
              h('button', { class: 'small', title: 'This is a card of this Pokémon', onclick: () => matchCard(cardOf(sl)) }, 'Match'),
              h('button', { class: 'ghost small', title: 'Not this Pokémon: remove from the list', onclick: () => excludeCard(sl.cardId) }, 'Remove'));
            return sl.manual ? h('div', { class: 'row' },
              h('span', { class: 'set-sub' }, 'Matched by hand'),
              h('button', { class: 'ghost small', onclick: () => unmatchCard(sl.cardId) }, 'Unmatch')) : null;
          })());
      })),
    )),
  );
}

// ---------- set view ----------

async function showSet(game, setId, refresh = false) {
  if (!refresh) view.replaceChildren(h('p', { class: 'loading' }, 'Loading cards…'));
  const data = await api(`/api/games/${game}/sets/${encodeURIComponent(setId)}${refresh ? '?refresh=1' : ''}`);
  if (state.current?.set.id !== data.set.id) { state.filter = 'all'; state.query = ''; }
  state.current = { game, ...data };
  state.sets[game] = null; // progress on the home page is now stale
  state.collections[game] = null;
  ext = null;
  renderSet();
}

// Where card edits go: the open set, or the artist / Pokémon page when `ext` is set (those pages edit copies in place).
let ext = null;
function ctxOf() {
  if (ext) return ext;
  const cur = state.current;
  return { game: cur.game, entries: cur.entries, rulesFor: () => cur.rules, redraw: renderSetKeepingFocus };
}

function variantsOf(card) {
  const { entries, rulesFor } = ctxOf();
  return resolveVariants({ ...card, variants: card.autoVariants }, entries[card.id], rulesFor(card));
}

function copiesOf(card, variant) {
  return ctxOf().entries[card.id]?.variants?.[variant] ?? [];
}

function cardState(card) {
  const vs = variantsOf(card);
  const owned = vs.filter((v) => copiesOf(card, v).length).length;
  return { variants: vs, owned, status: owned === 0 ? 'missing' : owned === vs.length ? 'complete' : 'partial' };
}

// Server builds a grayscale 3x3 PDF of the set. The first build downloads every image, so it can take a while.
async function downloadPrintable(e) {
  const btn = e.currentTarget;
  const { game, set } = state.current;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const res = await fetch(`/api/games/${game}/sets/${encodeURIComponent(set.id)}/printable.pdf`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: `${set.name.replace(/[^\w.-]+/g, '_')}_printable.pdf` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const missing = Number(res.headers.get('X-Missing-Images'));
    toast(missing ? `PDF saved, but ${missing} card image(s) could not be loaded and are blank boxes` : 'PDF saved', !!missing);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Printable PDF';
  }
}

function renderSet() {
  const { set, cards, entries, rules } = state.current;
  const progress = setProgress(cards.map((c) => ({ ...c, variants: c.autoVariants })), entries, rules);
  const q = state.query.toLowerCase();

  const shown = cards.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q) && !String(c.number).toLowerCase().includes(q) && !c.rarity.toLowerCase().includes(q)) return false;
    const s = cardState(c).status;
    if (state.filter === 'missing') return s === 'missing';
    if (state.filter === 'incomplete') return s !== 'complete';
    if (state.filter === 'owned') return s !== 'missing';
    return true;
  });

  const filters = [['all', 'All'], ['missing', 'Missing'], ['incomplete', 'Incomplete'], ['owned', 'Owned']];

  view.replaceChildren(
    h('div', { class: 'set-header' },
      h('a', { href: `#/game/${state.current.game}`, class: 'back' }, '← All sets'),
      h('div', { class: 'set-title' },
        set.logo ? h('img', { src: set.logo, alt: '', class: 'set-title-logo' }) : null,
        h('div', {}, h('h1', {}, set.name), h('div', { class: 'set-sub' }, [set.series, set.releaseDate].filter(Boolean).join(' · '))),
      ),
      h('div', { class: 'stats' },
        progressBar(progress.cardsOwned, progress.cards, 'Cards (any version)'),
        progressBar(progress.variantsOwned, progress.variants, 'Master set (every variant)'),
        h('div', { class: 'stat-line' },
          h('span', {}, `${progress.copies} copies`),
          h('span', {}, `Paid ${money(progress.paid)}`),
          h('span', {}, `Value ${money(progress.value)}`)),
      ),
    ),
    h('div', { class: 'toolbar' },
      h('div', { class: 'segmented' }, filters.map(([id, label]) =>
        h('button', { class: state.filter === id ? 'active' : null, onclick: () => { state.filter = id; renderSet(); } }, label))),
      h('input', {
        type: 'search', placeholder: 'Name, number, rarity…', value: state.query,
        oninput: (e) => { state.query = e.target.value; renderGrid(); },
      }),
      h('button', { class: 'ghost', onclick: openRules }, `Set variant rules${rules.length ? ` (${rules.length})` : ''}`),
      h('button', { class: 'ghost', onclick: downloadPrintable }, 'Printable PDF'),
      h('button', { class: 'ghost', onclick: () => showSet(state.current.game, set.id, true).then(() => toast('Card data refreshed')).catch((e) => toast(e.message, true)) }, 'Refresh cards'),
    ),
    h('div', { id: 'grid', class: 'grid' }),
  );
  renderGrid(shown);
}

function renderGrid(shown) {
  if (!shown) return renderSetKeepingFocus();
  const grid = $('#grid');
  grid.replaceChildren(...shown.map(tile));
  if (!shown.length) grid.append(h('p', { class: 'muted' }, 'Nothing here.'));
}

function renderSetKeepingFocus() {
  const active = document.activeElement;
  const wasSearch = active?.matches?.('.toolbar input[type=search]');
  const scroll = window.scrollY;
  renderSet();
  window.scrollTo(0, scroll);
  if (wasSearch) { const s = $('.toolbar input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

function tile(card) {
  const { variants, owned, status } = cardState(card);
  return h('div', { class: `tile ${status}`, 'data-id': card.id },
    h('button', {
      class: 'art',
      title: status === 'missing' ? 'Click to mark as owned' : 'Click to unmark (or open details)',
      onclick: () => clickArt(card),
    },
    cardImage(card),
    status !== 'missing' && variants.length > 1 ? h('span', { class: 'badge' }, status === 'complete' ? '✓' : `${owned}/${variants.length}`) : null,
    status === 'complete' && variants.length === 1 ? h('span', { class: 'badge' }, '✓') : null,
    ),
    h('div', { class: 'meta' },
      h('span', { class: 'num' }, `#${card.number}`),
      h('span', { class: 'name', title: card.name }, card.name),
      h('button', { class: 'info', title: 'Details, condition, grade, price', onclick: () => openCard(card) }, '⋯'),
    ),
    h('div', { class: 'pills' }, variants.map((v) => {
      const n = copiesOf(card, v).length;
      return h('div', { class: `pill${n ? ' owned' : ''}`, 'data-variant': v },
        h('button', { class: 'step', title: `Remove a ${v} copy`, 'aria-label': `Remove a ${v} copy`, disabled: !n, onclick: () => removeCopy(card, v) }, '−'),
        h('button', { class: 'label', title: `${v}: ${n ? `${n} owned` : 'missing'} (click for details)`, onclick: () => openCard(card) },
          v, n ? ` ×${n}` : ''),
        h('button', { class: 'step', title: `Add a ${v} copy`, 'aria-label': `Add a ${v} copy`, onclick: () => addCopy(card, v) }, '+'),
      );
    })),
  );
}

// ---------- ownership mutations ----------

const newCopy = () => ({ id: Math.random().toString(36).slice(2, 10), condition: 'NM', grader: 'Raw', grade: '', pricePaid: null, value: null, acquired: '', notes: '' });
const isPlain = (c) => c.condition === 'NM' && c.grader === 'Raw' && !c.grade && c.pricePaid == null && c.value == null && !c.acquired && !c.notes;
const blankEntry = () => ({ variants: {}, customVariants: [], hiddenVariants: [] });

function totalCopies(card) {
  return Object.values(ctxOf().entries[card.id]?.variants ?? {}).reduce((n, cs) => n + cs.length, 0);
}

async function saveEntry(card, mutate, { redrawModal = true } = {}) {
  const { entries, game } = ctxOf();
  if (ext) ext.dirty = true;
  const before = entries[card.id];
  const next = structuredClone(before ?? blankEntry());
  mutate(next);
  for (const [v, cs] of Object.entries(next.variants)) if (!cs.length) delete next.variants[v];
  entries[card.id] = next;
  rerender(card, redrawModal);
  try {
    entries[card.id] = await api(`/api/games/${game}/cards/${encodeURIComponent(card.id)}`, { method: 'PUT', body: JSON.stringify(next) });
    state.sets[game] = null; // progress on the home page is now stale
    state.collections[game] = null;
  } catch (err) {
    if (before) entries[card.id] = before; else delete entries[card.id];
    rerender(card);
    toast(`Not saved: ${err.message}`, true);
  }
}

function rerender(card, redrawModal = true) {
  ctxOf().redraw();
  if (redrawModal && modal.open && modal.dataset.card === card.id) renderCardModal(card);
}

// Clicking art: add a copy if you own none; remove a lone untouched copy; otherwise open details
// so a misclick can't wipe a copy you've recorded a grade or price for.
function clickArt(card) {
  const total = totalCopies(card);
  if (total === 0) {
    const [first] = variantsOf(card);
    if (!first) return openCard(card);
    return saveEntry(card, (e) => { e.variants[first] = [newCopy()]; });
  }
  const all = Object.values(ctxOf().entries[card.id].variants).flat();
  if (total === 1 && isPlain(all[0])) return saveEntry(card, (e) => { e.variants = {}; });
  openCard(card);
}

function addCopy(card, variant) {
  return saveEntry(card, (e) => { (e.variants[variant] ??= []).push(newCopy()); });
}

// Removes the newest untouched copy first; only prompts if every copy has recorded details.
function removeCopy(card, variant) {
  const copies = copiesOf(card, variant);
  if (!copies.length) return;
  const target = [...copies].reverse().find(isPlain) ?? copies.at(-1);
  if (!isPlain(target) && !confirm(`Remove a ${variant} copy and its recorded details?`)) return;
  return saveEntry(card, (e) => { e.variants[variant] = e.variants[variant].filter((x) => x.id !== target.id); });
}

// ---------- card detail modal ----------

function openCard(card) {
  modal.dataset.card = card.id;
  renderCardModal(card);
  if (!modal.open) modal.showModal();
}

// The card's artist, with a field to correct it when the databases are blank or wrong. Works from a set page
// (overrides come with the set) and from artist / Pokémon pages (an assigned card carries `overridden`).
function artistRow(card) {
  const ctx = ctxOf();
  if (!state.meta.games.find((g) => g.id === ctx.game)?.artists) return null;
  const overrides = ext ? (ext.artistOverrides ??= {}) : (state.current.artistOverrides ??= {});
  const mine = card.id in overrides ? overrides[card.id] : card.overridden ? card.artist : undefined;
  const input = h('input', { value: mine ?? '', placeholder: card.artist ? 'Correct the artist' : 'Artist (not in database)', maxlength: 100 });
  const save = async (value) => {
    try {
      const { artist } = await setCardArtist(ctx.game, card.id, value);
      if (artist) overrides[card.id] = artist; else overrides[card.id] = '';
      toast(artist ? 'Artist saved' : 'Artist cleared');
      if (ext?.onArtistChange) ext.onArtistChange(); else renderCardModal(card);
    } catch (err) { toast(err.message, true); }
  };
  return h('div', { class: 'artist-row' },
    h('span', { class: 'muted' }, mine ? `Artist: ${mine} (set by you)` : card.artist ? `Artist: ${card.artist}` : 'Artist: not in database'),
    h('div', { class: 'row' }, input, h('button', { class: 'small', onclick: () => save(input.value) }, 'Save'),
      mine ? h('button', { class: 'ghost small', onclick: () => save('') }, 'Clear') : null),
  );
}

function renderCardModal(card) {
  const entry = ctxOf().entries[card.id] ?? blankEntry();
  const variants = variantsOf(card);
  const fromRules = new Set(ctxOf().rulesFor(card).filter((r) => !r.rarities.length || r.rarities.includes(card.rarity)).map((r) => r.name));
  // Variants with copies but no longer listed (e.g. hidden) still show, so no copy is ever invisible.
  const orphaned = Object.keys(entry.variants).filter((v) => !variants.includes(v));
  const { conditions, graders } = state.meta;

  const copyRow = (variant, copy) => {
    const update = (field, parse = (x) => x) => (e) =>
      saveEntry(card, (en) => {
        const c = en.variants[variant].find((x) => x.id === copy.id);
        if (c) c[field] = parse(e.target.value);
      }, { redrawModal: field === 'grader' });
    const num = (x) => (x === '' ? null : Number(x));
    return h('div', { class: 'copy' },
      h('label', {}, 'Condition', h('select', { onchange: update('condition') }, conditions.map((c) => h('option', { selected: c === copy.condition }, c)))),
      h('label', {}, 'Graded by', h('select', { onchange: update('grader') }, graders.map((g) => h('option', { selected: g === copy.grader }, g)))),
      h('label', {}, 'Grade', h('input', { value: copy.grade, placeholder: copy.grader === 'Raw' ? '—' : '10', disabled: copy.grader === 'Raw', onchange: update('grade') })),
      h('label', {}, 'Paid $', h('input', { type: 'number', min: 0, step: '0.01', value: copy.pricePaid ?? '', onchange: update('pricePaid', num) })),
      h('label', {}, 'Value $', h('input', { type: 'number', min: 0, step: '0.01', value: copy.value ?? '', onchange: update('value', num) })),
      h('label', {}, 'Acquired', h('input', { type: 'date', value: copy.acquired, onchange: update('acquired') })),
      h('label', { class: 'wide' }, 'Notes', h('input', { value: copy.notes, maxlength: 500, onchange: update('notes') })),
      h('button', {
        class: 'danger small', title: 'Remove this copy',
        onclick: () => (isPlain(copy) || confirm('Remove this copy and its details?')) &&
          saveEntry(card, (en) => { en.variants[variant] = en.variants[variant].filter((x) => x.id !== copy.id); }),
      }, 'Remove'),
    );
  };

  const variantBlock = (v, orphan = false) => {
    const copies = entry.variants[v] ?? [];
    const custom = entry.customVariants.includes(v);
    const auto = card.autoVariants.includes(v) || fromRules.has(v);
    return h('section', { class: `variant${copies.length ? ' owned' : ''}` },
      h('div', { class: 'variant-head' },
        h('h3', {}, v, orphan ? h('span', { class: 'muted' }, ' (hidden)') : null),
        h('span', { class: 'muted' }, copies.length ? `${copies.length} owned` : 'missing'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => saveEntry(card, (en) => { (en.variants[v] ??= []).push(newCopy()); }) }, '+ Add copy'),
        orphan ? h('button', { class: 'ghost small', onclick: () => saveEntry(card, (en) => { en.hiddenVariants = en.hiddenVariants.filter((x) => x !== v); }) }, 'Unhide') :
        custom && !auto ? h('button', { class: 'ghost small', title: 'Remove this variant from this card', onclick: () => saveEntry(card, (en) => { en.customVariants = en.customVariants.filter((x) => x !== v); }) }, 'Delete variant') :
        h('button', { class: 'ghost small', title: 'This printing doesn’t exist; stop counting it', onclick: () => saveEntry(card, (en) => { en.hiddenVariants = [...new Set([...en.hiddenVariants, v])]; }) }, 'Hide'),
      ),
      copies.map((c) => copyRow(v, c)),
    );
  };

  const hiddenEmpty = entry.hiddenVariants.filter((v) => !orphaned.includes(v));
  const addInput = h('input', { placeholder: 'e.g. Poké Ball Reverse', maxlength: 60 });
  const addVariant = () => {
    const name = addInput.value.trim();
    if (!name) return;
    saveEntry(card, (en) => {
      en.hiddenVariants = en.hiddenVariants.filter((x) => x !== name);
      if (!variantsOf(card).includes(name)) en.customVariants = [...new Set([...en.customVariants, name])];
    });
  };

  modalBody.replaceChildren(
    h('div', { class: 'modal-head' },
      h('div', {}, h('h2', {}, card.name), h('div', { class: 'muted' }, `#${card.number} · ${card.rarity}`), artistRow(card)),
      h('button', { class: 'ghost close', onclick: () => modal.close(), 'aria-label': 'Close' }, '✕'),
    ),
    h('div', { class: 'modal-grid' },
      h('div', { class: `modal-art ${cardState(card).status}` }, cardImage(card, true)),
      h('div', { class: 'variants' },
        variants.map((v) => variantBlock(v)),
        orphaned.map((v) => variantBlock(v, true)),
        h('div', { class: 'add-variant' },
          h('label', {}, 'Add a variant to this card', h('div', { class: 'row' }, addInput, h('button', { class: 'small', onclick: addVariant }, 'Add'))),
          hiddenEmpty.length ? h('div', { class: 'muted' }, 'Hidden: ', hiddenEmpty.map((v) =>
            h('button', { class: 'link', onclick: () => saveEntry(card, (en) => { en.hiddenVariants = en.hiddenVariants.filter((x) => x !== v); }) }, `${v} (unhide)`))) : null,
        ),
      ),
    ),
  );
}

// ---------- set rules modal ----------

function openRules() {
  const { cards, game, set } = state.current;
  const rarities = [...new Set(cards.map((c) => c.rarity))];
  let draft = structuredClone(state.current.rules);
  modal.dataset.card = '';

  const render = () => {
    modalBody.replaceChildren(
      h('div', { class: 'modal-head' },
        h('div', {}, h('h2', {}, 'Set variant rules'),
          h('p', { class: 'muted' }, 'Add printings the card database doesn’t know about to every card of the chosen rarities. Example: “Poké Ball Reverse” on Common and Uncommon. Leave all rarities unchecked to apply to every card.')),
        h('button', { class: 'ghost close', onclick: () => modal.close(), 'aria-label': 'Close' }, '✕'),
      ),
      ...draft.map((rule, i) => h('section', { class: 'rule' },
        h('div', { class: 'row' },
          h('input', { value: rule.name, placeholder: 'Variant name', maxlength: 60, oninput: (e) => { rule.name = e.target.value; } }),
          h('button', { class: 'danger small', onclick: () => { draft.splice(i, 1); render(); } }, 'Delete'),
        ),
        h('div', { class: 'rarities' }, rarities.map((r) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: rule.rarities.includes(r), onchange: (e) => {
            rule.rarities = e.target.checked ? [...rule.rarities, r] : rule.rarities.filter((x) => x !== r);
          } }),
          `${r} (${cards.filter((c) => c.rarity === r).length})`))),
      )),
      h('div', { class: 'row' },
        h('button', { class: 'ghost', onclick: () => { draft.push({ name: '', rarities: [] }); render(); } }, '+ Add rule'),
        h('div', { class: 'spacer' }),
        h('button', { onclick: async () => {
          try {
            state.current.rules = await api(`/api/games/${game}/sets/${encodeURIComponent(set.id)}/rules`, { method: 'PUT', body: JSON.stringify(draft) });
            modal.close();
            renderSet();
            toast('Rules saved');
          } catch (err) { toast(err.message, true); }
        } }, 'Save rules'),
      ),
    );
  };
  if (!draft.length) draft.push({ name: '', rarities: [] });
  render();
  modal.showModal();
}

modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
// Variants added or hidden in the modal change the Pokémon page's slots, so reload it once the modal closes.
modal.addEventListener('close', () => { if (ext?.dirty) { ext.dirty = false; ext.onClose?.(); } });
window.addEventListener('hashchange', route);
route();
