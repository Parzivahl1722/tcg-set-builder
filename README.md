# TCG Set Builder

A local master-set tracker for Pokémon and Disney Lorcana. Each set shows every card: the ones you own are in color, the ones you're missing are grayed out. Click a card to mark it owned.

## Run it

Requires Node 18 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000.

On a Mac you can instead double-click `start.command`. It installs dependencies on first run, starts the app, and opens your browser. Drag it to the Dock or make an alias on the Desktop for a one-click shortcut. Closing its Terminal window stops the app.

`start.command` stores your collection in `~/TCG Set Builder Data`, outside the project folder, so re-cloning the repo can't lose it. The first time it runs, it copies an existing `data/collection.json` (and backups) from the project folder into that location and leaves the original alone. To use a synced folder instead, launch it with `DATA_DIR`, for example `DATA_DIR=~/Library/Mobile\ Documents/com~apple~CloudDocs/tcg ./start.command`. Running `npm start` directly still uses `data/` inside the project unless you set `DATA_DIR`, so use one launch method consistently or the two will show different collections.

## How it works

- **Click a card** to add one copy and turn it color. Click again to remove it. If that copy has details recorded (grade, price, notes), clicking opens the detail panel instead, so a misclick can't delete it.
- **Variant pills** under each card (Normal, Reverse Holo, Foil…) toggle each printing separately. A badge like `1/3` means you own some variants but not all.
- **⋯ opens details**: multiple copies per variant, condition, grader and grade (PSA, BGS, CGC, SGC, TAG), price paid, current value, date acquired, notes.
- **Two progress bars per set**: *Cards* counts a card once you own any version. *Master set* counts every variant.

### By artist (Pokémon)

**By artist** on the Pokémon set list opens a page that shows what share of one artist's cards you own, across every set. Type a name (for example `Yuka Morii`) or pick from the artists of cards you already own. Owned cards are in color, missing ones grayed out; filter by All, Owned or Missing.

- The percentage counts a card once if you own any printing of it. It uses the artist field in the Pokémon TCG API, queried live and cached for 7 days (**Refresh from API** forces an update). If the API is down it scans the GitHub data dump instead, which is slower.
- The artist list on the landing page only covers sets you have opened. Sets cached before this feature existed need **Refresh cards** once to pick up artist names.
- Artist names are free text in the database. Matching ignores case, accents and spacing and also finds collaboration cards, but a misspelled or differently romanized name will undercount.
- **The database leaves the artist blank for whole sets** (as of this writing: Stellar Crown, Surging Sparks, Prismatic Evolutions, Journey Together, Destined Rivals, Mega Evolution, Perfect Order). Those cards can't show up under any artist until you assign one. Two ways:
  - On an artist page, open **Add cards the database doesn’t credit to…** and paste one card per line: `Stellar Crown #91`, `Surging Sparks 73`, or a card id like `sv7-91`. It matches the set by name or id, then the card number, and tells you each card it added (check the name against what you meant) and any line it couldn't read. If the database credits a card to someone else, it says so; your assignment wins.
  - In any card's **⋯** panel, type the artist under the card name and **Save**.
  Assignments are stored in `collection.json` under `artistOverrides` (`"pokemon:sv7-91": "Shimaris Yukichi"`), so they are backed up and exported with everything else. Remove one with **remove** on the artist page or **Clear** in the card panel. Take the credit from the card itself; aggregator sites can be wrong.
- Lorcana has no artist page.

### Variants

Where variants come from:

| Game | Source | Notes |
|---|---|---|
| Pokémon | Which printings have TCGplayer prices in the [Pokémon TCG API](https://pokemontcg.io) | Falls back to rarity rules when price data is missing |
| Lorcana | Rarity, from [Lorcast](https://lorcast.com) | Normal + Foil; Enchanted, Epic and Iconic are foil-only |

The databases don't track everything collectors care about (Poké Ball and Master Ball reverse holos, stamped promos, errors). Two ways to fix that:

- **Set variant rules** add a variant to every card of chosen rarities in a set. Example: "Poké Ball Reverse" on Common and Uncommon.
- **Per card**, in the ⋯ panel: add a custom variant, or **Hide** a variant that doesn't actually exist so it stops counting against you.

## Your data

- `data/collection.json` is your collection. Every click saves to it immediately. `data/` is git-ignored on purpose, so it is not saved to GitHub.
- `data/backups/` gets a dated copy (`collection-YYYY-MM-DD.json`) the first time you change anything each day. It holds the collection as it was *before* that day's edits. The newest 30 are kept; set `BACKUP_KEEP` to change that, or `0` to turn backups off. To restore, stop the app and copy a backup over `collection.json`.
- Backups sit on the same disk as the collection, so they protect against mistakes, not a dead laptop. For that, point `DATA_DIR` at a synced folder (`DATA_DIR=~/Dropbox/tcg npm start`) or use **Export backup** now and then.
- `data/cache/` holds downloaded card lists. Delete it any time; it re-downloads. Use **Refresh cards** on a set to pull updates.
- Set `DATA_DIR` to keep data somewhere else (for example a synced Dropbox or iCloud folder), and `PORT` to change the port.
- Optional: set `POKEMONTCG_API_KEY` ([free key](https://dev.pokemontcg.io)) for higher Pokémon API rate limits.

The server only listens on `localhost`. There's no login, so don't expose it to a network as-is.

## Development

```sh
npm run dev   # restarts on server changes
npm test
```

- `server/sources/` holds one file per game. To add a game, export `{ id, name, fetchSets, fetchCards }` returning the same card shape, then register it in `server/index.js`.
- `server/collection.js` has the variant and progress logic. The browser imports the same file.
- `server/store.js` is the only code that touches `collection.json`. Swap it out to move storage to a database.
