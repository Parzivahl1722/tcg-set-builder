import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createCache } from './cache.js';
import { createStore } from './store.js';
import pokemon from './sources/pokemon.js';
import lorcana from './sources/lorcana.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 3000);

const backupKeep = Number.isFinite(Number(process.env.BACKUP_KEEP)) ? Number(process.env.BACKUP_KEEP) : 30;
const store = await createStore(path.join(dataDir, 'collection.json'), { backupKeep });
const cache = createCache(path.join(dataDir, 'cache'));
const app = createApp({ sources: { pokemon, lorcana }, cache, store });

// Bound to localhost: there is no login, so don't expose it to the network.
app.listen(port, '127.0.0.1', () => {
  console.log(`TCG Set Builder running at http://localhost:${port}`);
  console.log(`Collection file: ${path.join(dataDir, 'collection.json')}`);
  console.log(backupKeep > 0 ? `Daily backups: ${path.join(dataDir, 'backups')} (keeping ${backupKeep})` : 'Daily backups: off');
});
