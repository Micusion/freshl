/* freshl demo — pure JS, no CSS, no frameworks.
   Server ships heavy garbage data. Metrics come from cache.stats().
   Update flow: dataset:updated event with a resolve rule invalidates only
   the changed keys; the invalidate subscriber re-fetches them automatically. */
(function () {
  'use strict';
  const { createFreshl } = Freshl;

  const cache = createFreshl({
    defaultPolicy: { ttl: 5000, swr: 30000, staleIfError: 60000 },
    maxEntries: 20,
  });

  const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const keyOf = (name) => 'dataset:' + name;

  cache.bindEvent('dataset:updated', {
    resolve: (payload) => ({ keys: payload.names.map(keyOf) }),
  });

  const logEl = document.getElementById('log');
  function log(msg) {
    logEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + logEl.textContent;
  }

  let bytes = 0;
  async function apiDataset(name) {
    const res = await fetch('/api/datasets/' + name);
    const text = await res.text();
    bytes += text.length;
    return JSON.parse(text);
  }

  const loaded = new Set();
  function readDataset(name) {
    return cache
      .fetch(keyOf(name), () => apiDataset(name), { tags: ['datasets'] })
      .catch((e) => log(`${name}: ${e.message}`));
  }

  // subscriber: re-fetch invalidated keys automatically
  cache.on('invalidate', (p) => {
    const names = p.keys.map((k) => k.replace(/^dataset:/, '')).filter((n) => loaded.has(n));
    if (names.length) {
      log(`auto-refresh: ${names.join(', ')}`);
      names.forEach(readDataset);
    }
  });

  function renderStats() {
    const s = cache.stats();
    const set = (id, v) => (document.getElementById(id).textContent = v);
    set('s-hitrate', s.hitRate === null ? '—' : Math.round(s.hitRate * 100) + '%');
    set('s-saved', s.hits);
    set('s-hit', s.avgHitLatency === null ? '—' : s.avgHitLatency.toFixed(1));
    set('s-miss', s.avgMissLatency === null ? '—' : Math.round(s.avgMissLatency));
    set('s-network', s.network);
    set('s-invalidations', s.invalidations + ' / ' + s.invalidatedKeys);
    set('s-payload', (bytes / 1048576).toFixed(2));
    set('s-speedup',
      s.avgHitLatency !== null && s.avgMissLatency !== null
        ? (s.avgMissLatency / Math.max(s.avgHitLatency, 0.05)).toFixed(0) + '×'
        : '—');
  }

  function renderRows() {
    document.getElementById('rows').innerHTML = cache.keys().sort().map((key) => {
      const m = cache.meta(key);
      const state = m.stale ? (cache.has(key) ? 'stale (swr)' : 'expired') : 'fresh';
      const v = cache.peek(key);
      return `<tr>
        <td>${key}</td><td>${m.tags.join(', ')}</td>
        <td>${(m.age / 1000).toFixed(1)}s</td><td>${state}</td>
        <td>${m.hits}</td><td>v${v ? v.version : '—'}</td>
      </tr>`;
    }).join('');
  }

  async function run(label, fn) {
    const t = performance.now();
    await fn();
    log(`${label}: ${Math.round(performance.now() - t)} ms`);
    renderStats(); renderRows();
  }
  const loadAll = () =>
    run('load 6 datasets', async () => {
      await Promise.all(NAMES.map((n) => readDataset(n).then(() => loaded.add(n))));
    });

  document.getElementById('b-load').onclick = loadAll;
  document.getElementById('b-reread').onclick = () =>
    run('re-read all', () => Promise.all(NAMES.map(readDataset)));
  document.getElementById('b-mutate').onclick = async () => {
    for (const name of ['alpha', 'beta']) {
      const res = await fetch(`/api/datasets/${name}/update`, { method: 'POST' });
      const info = await res.json();
      log(`server: ${info.dataset} → v${info.version}`);
    }
    const hit = cache.emit('dataset:updated', { names: ['alpha', 'beta'] });
    log(`event dataset:updated → invalidated ${hit.length} keys`);
    renderStats(); renderRows();
  };
  document.getElementById('b-invalidate-tags').onclick = () => {
    const hit = cache.invalidate({ tags: ['datasets'] });
    log(`invalidated by tag "datasets": ${hit.length} keys`);
    renderStats(); renderRows();
  };
  document.getElementById('b-stress').onclick = () =>
    run('stress 50 parallel reads', () =>
      Promise.all(Array.from({ length: 50 }, (_, i) => readDataset(NAMES[i % NAMES.length]))));

  setInterval(renderRows, 500);
  renderStats();
  loadAll();
})();
