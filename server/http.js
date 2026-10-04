const USER_AGENT = 'tcg-set-builder/1.0 (personal collection tracker)';

export async function getJson(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}
