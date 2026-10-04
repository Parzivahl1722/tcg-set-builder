import fs from 'node:fs/promises';
import path from 'node:path';

// Disk cache for card data. If a refresh fails, the stale copy is served instead.
export function createCache(dir) {
  const file = (key) => path.join(dir, `${key.replace(/[^\w.-]/g, '_')}.json`);

  async function read(key) {
    try {
      return JSON.parse(await fs.readFile(file(key), 'utf8'));
    } catch {
      return null;
    }
  }

  async function get(key, loader, { maxAgeMs = Infinity, refresh = false } = {}) {
    const cached = await read(key);
    if (cached && !refresh && Date.now() - cached.fetchedAt < maxAgeMs) return cached.data;
    try {
      const data = await loader();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), JSON.stringify({ fetchedAt: Date.now(), data }));
      return data;
    } catch (err) {
      if (cached) {
        console.warn(`[cache] refresh of ${key} failed (${err.message}); serving cached copy`);
        return cached.data;
      }
      throw err;
    }
  }

  async function peek(key) {
    return (await read(key))?.data ?? null;
  }

  return { get, peek };
}
