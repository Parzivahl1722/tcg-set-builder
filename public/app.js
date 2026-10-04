import { resolveVariants, setProgress } from '/lib/collection.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const modal = $('#modal');
const modalBody = $('#modal-body');

const state = {
  meta: null,
  game: 'pokemon',
  sets: {}, // game -> list
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
    ),
    list,
  );
}

// ---------- set view ----------

async function showSet(game, setId, refresh = false) {
  if (!refresh) view.replaceChildren(h('p', { class: 'loading' }, 'Loading cards…'));
  const data = await api(`/api/games/${game}/sets/${encodeURIComponent(setId)}${refresh ? '?refresh=1' : ''}`);
  if (state.current?.set.id !== data.set.id) { state.filter = 'all'; state.query = ''; }
  state.current = { game, ...data };
  state.sets[game] = null; // progress on the home page is now stale
  renderSet();
}

function variantsOf(card) {
  const { entries, rules } = state.current;
  return resolveVariants({ ...card, variants: card.autoVariants }, entries[card.id], rules);
}

function copiesOf(card, variant) {
  return state.current.entries[card.id]?.variants?.[variant] ?? [];
}

function cardState(card) {
  const vs = variantsOf(card);
  const owned = vs.filter((v) => copiesOf(card, v).length).length;
  return { variants: vs, owned, status: owned === 0 ? 'missing' : owned === vs.length ? 'complete' : 'partial' };
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
      return h('button', { class: `pill${n ? ' owned' : ''}`, title: n ? `${v}: ${n} owned` : `${v}: missing`, onclick: () => clickVariant(card, v) },
        v, n > 1 ? ` ×${n}` : '');
    })),
  );
}

// ---------- ownership mutations ----------

const newCopy = () => ({ id: Math.random().toString(36).slice(2, 10), condition: 'NM', grader: 'Raw', grade: '', pricePaid: null, value: null, acquired: '', notes: '' });
const isPlain = (c) => c.condition === 'NM' && c.grader === 'Raw' && !c.grade && c.pricePaid == null && c.value == null && !c.acquired && !c.notes;
const blankEntry = () => ({ variants: {}, customVariants: [], hiddenVariants: [] });

function totalCopies(card) {
  return Object.values(state.current.entries[card.id]?.variants ?? {}).reduce((n, cs) => n + cs.length, 0);
}

async function saveEntry(card, mutate, { redrawModal = true } = {}) {
  const { entries, game } = state.current;
  const before = entries[card.id];
  const next = structuredClone(before ?? blankEntry());
  mutate(next);
  for (const [v, cs] of Object.entries(next.variants)) if (!cs.length) delete next.variants[v];
  entries[card.id] = next;
  rerender(card, redrawModal);
  try {
    entries[card.id] = await api(`/api/games/${game}/cards/${encodeURIComponent(card.id)}`, { method: 'PUT', body: JSON.stringify(next) });
  } catch (err) {
    if (before) entries[card.id] = before; else delete entries[card.id];
    rerender(card);
    toast(`Not saved: ${err.message}`, true);
  }
}

function rerender(card, redrawModal = true) {
  renderSetKeepingFocus();
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
  const all = Object.values(state.current.entries[card.id].variants).flat();
  if (total === 1 && isPlain(all[0])) return saveEntry(card, (e) => { e.variants = {}; });
  openCard(card);
}

function clickVariant(card, variant) {
  const copies = copiesOf(card, variant);
  if (copies.length === 0) return saveEntry(card, (e) => { e.variants[variant] = [newCopy()]; });
  if (copies.length === 1 && isPlain(copies[0])) return saveEntry(card, (e) => { delete e.variants[variant]; });
  openCard(card);
}

// ---------- card detail modal ----------

function openCard(card) {
  modal.dataset.card = card.id;
  renderCardModal(card);
  if (!modal.open) modal.showModal();
}

function renderCardModal(card) {
  const entry = state.current.entries[card.id] ?? blankEntry();
  const variants = variantsOf(card);
  const fromRules = new Set(state.current.rules.filter((r) => !r.rarities.length || r.rarities.includes(card.rarity)).map((r) => r.name));
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
      h('div', {}, h('h2', {}, card.name), h('div', { class: 'muted' }, `#${card.number} · ${card.rarity}`)),
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
window.addEventListener('hashchange', route);
route();
