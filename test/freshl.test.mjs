import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshl, MemoryStorage } from '../src/freshl.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('set/get/has basic', () => {
  const c = createFreshl();
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.has('a'), true);
  assert.equal(c.get('missing'), undefined);
  assert.deepEqual(c.keys(), ['a']);
});

test('ttl expiry', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30 } });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  await sleep(60);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.has('a'), false);
});

test('per-entry policy overrides default', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30 } });
  c.set('short', 1);
  c.set('long', 2, { policy: { ttl: 10000 } });
  await sleep(60);
  assert.equal(c.get('short'), undefined);
  assert.equal(c.get('long'), 2);
});

test('fetch: miss then fresh, deduped in-flight', async () => {
  const c = createFreshl();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await sleep(20);
    return 'v';
  };
  const [a, b] = await Promise.all([c.fetch('k', fetcher), c.fetch('k', fetcher)]);
  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(calls, 1, 'in-flight calls must be deduped');
  assert.equal(await c.fetch('k', fetcher), 'v');
  assert.equal(calls, 1, 'fresh value must not refetch');
});

test('fetch: stale-while-revalidate serves stale and refreshes in background', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30, swr: 5000 } });
  let calls = 0;
  const fetcher = async () => 'v' + ++calls;
  assert.equal(await c.fetch('k', fetcher), 'v1');
  await sleep(60); // now stale, but within swr
  assert.equal(await c.fetch('k', fetcher), 'v1', 'stale value served immediately');
  await sleep(30); // background revalidation
  assert.equal(c.peek('k'), 'v2');
});

test('fetch: staleIfError keeps stale data when fetcher fails', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30, staleIfError: 5000 } });
  let fail = false;
  const fetcher = async () => {
    if (fail) throw new Error('network');
    return 'ok';
  };
  assert.equal(await c.fetch('k', fetcher), 'ok');
  await sleep(60);
  fail = true;
  assert.equal(await c.fetch('k', fetcher), 'ok', 'stale served on error');
});

test('tag invalidation', () => {
  const c = createFreshl();
  c.set('user:1', { n: 1 }, { tags: ['users'] });
  c.set('user:2', { n: 2 }, { tags: ['users'] });
  c.set('post:1', { n: 3 }, { tags: ['posts'] });
  const hit = c.invalidate({ tags: ['users'] });
  assert.deepEqual(hit.sort(), ['user:1', 'user:2']);
  assert.equal(c.has('post:1'), true);
  assert.equal(c.has('user:1'), false);
});

test('dependency cascade by key', () => {
  const c = createFreshl();
  c.set('user:1', {});
  c.set('profile:1', {}, { dependsOn: ['user:1'] });
  c.set('feed', {}, { dependsOn: ['profile:1'] }); // transitive
  c.set('other', {});
  const hit = c.invalidate('user:1');
  assert.deepEqual(hit.sort(), ['feed', 'profile:1', 'user:1']);
  assert.equal(c.has('other'), true);
});

test('dependency cascade by tag', () => {
  const c = createFreshl();
  c.set('user:1', {}, { tags: ['users'] });
  c.set('feed', {}, { dependsOn: { tags: ['users'] } });
  const hit = c.invalidate({ tags: ['users'] });
  assert.deepEqual(hit.sort(), ['feed', 'user:1']);
});

test('events: bindEvent invalidates and notifies', () => {
  const c = createFreshl();
  c.set('user:1', {}, { tags: ['users'] });
  c.bindEvent('user:updated', { tags: ['users'] });
  const seen = [];
  c.on('event:user:updated', (m) => seen.push(m.name));
  const invalidated = c.emit('user:updated', { id: 1 });
  assert.deepEqual(invalidated, ['user:1']);
  assert.equal(c.has('user:1'), false);
  assert.deepEqual(seen, ['user:updated']);
});

test('events: resolve rule invalidates exactly what the payload says', () => {
  const c = createFreshl();
  c.set('dataset:alpha', {}, { tags: ['datasets'] });
  c.set('dataset:beta', {}, { tags: ['datasets'] });
  c.set('dataset:gamma', {}, { tags: ['datasets'] });
  c.bindEvent('dataset:updated', {
    resolve: (payload) => ({ keys: payload.names.map((n) => 'dataset:' + n) }),
  });
  const hit = c.emit('dataset:updated', { names: ['alpha', 'beta'] });
  assert.deepEqual(hit.sort(), ['dataset:alpha', 'dataset:beta']);
  assert.equal(c.has('dataset:gamma'), true, 'untouched entry must survive');
});

test('subscribers: key watcher sees refresh and invalidate', async () => {
  const c = createFreshl();
  const log = [];
  c.on('key:k', (m) => log.push(m.type));
  await c.fetch('k', async () => 1);
  c.invalidate('k');
  assert.deepEqual(log, ['set', 'refresh', 'invalidate']);
});

test('subscribers: object target with unsubscribe', () => {
  const c = createFreshl();
  const log = [];
  const off = c.on({ tags: ['users'], events: ['changed'] }, (m) => log.push(m));
  c.set('u', 1, { tags: ['users'] }); // tag subscribers only get invalidation events
  c.invalidate({ tags: ['users'] });
  c.emit('changed');
  off();
  c.invalidate({ tags: ['users'] });
  assert.equal(log.length, 2);
});

test('LRU eviction', () => {
  const c = createFreshl({ maxEntries: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a'); // a becomes recently used
  c.set('c', 3); // evicts b
  assert.deepEqual(c.keys().sort(), ['a', 'c']);
});

test('delete and clear', () => {
  const c = createFreshl();
  c.set('a', 1, { tags: ['t'] });
  c.set('b', 2, { tags: ['t'] });
  c.delete('a');
  assert.equal(c.has('a'), false);
  c.clear();
  assert.equal(c.size(), 0);
  assert.deepEqual(c.invalidate({ tags: ['t'] }), []);
});

test('persistence via storage adapter survives a new instance', async () => {
  const storage = new MemoryStorage();
  const c1 = createFreshl({ storage, defaultPolicy: { ttl: 60000 } });
  c1.set('a', 1, { tags: ['t'] });
  c1.set('gone', 2);
  c1.delete('gone');
  const c2 = createFreshl({ storage, namespace: 'freshl' });
  assert.equal(c2.get('a'), 1);
  assert.equal(c2.get('gone'), undefined);
  assert.deepEqual(c2.meta('a').tags, ['t']);
});

test('persistence drops fully expired entries', async () => {
  const storage = new MemoryStorage();
  const c1 = createFreshl({ storage, defaultPolicy: { ttl: 20 } });
  c1.set('old', 1);
  await sleep(50);
  const c2 = createFreshl({ storage });
  assert.equal(c2.get('old'), undefined);
  assert.equal(c2.size(), 0);
});

test('meta reports freshness', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30 } });
  c.set('a', 1);
  assert.equal(c.meta('a').stale, false);
  await sleep(40);
  assert.equal(c.meta('a').stale, true);
  assert.equal(c.meta('nope'), null);
});

test('invalidate with cascade disabled', () => {
  const c = createFreshl();
  c.set('user:1', {});
  c.set('feed', {}, { dependsOn: ['user:1'] });
  const hit = c.invalidate('user:1', { cascade: false });
  assert.deepEqual(hit, ['user:1']);
  assert.equal(c.has('feed'), true);
});

test('stats: hits/misses/latency/invalidations built-in instrumentation', async () => {  const c = createFreshl({ defaultPolicy: { ttl: 10000 } });
  let s = c.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.hitRate, null);

  await c.fetch('k', async () => 'v1'); // miss
  await c.fetch('k', async () => 'x');  // hit (fresh)
  const s2 = c.stats();
  assert.equal(s2.misses, 1);
  assert.equal(s2.hits, 1);
  assert.equal(s2.network, 1, 'fresh hit must not call fetcher');
  assert.equal(s2.hitRate, 0.5);
  assert.ok(s2.avgMissLatency > 0);
  assert.ok(s2.avgHitLatency < s2.avgMissLatency);

  c.invalidate({ tags: [] }); // no-op invalidation still counts as one
  s = c.stats();
  assert.equal(s.invalidations, 1);
  assert.equal(s.invalidatedKeys, 0);

  c.resetStats();
  s = c.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(c.get('k'), 'v1', 'resetStats keeps entries');
});

test('race: in-flight revalidate must not resurrect an invalidated key', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 30, swr: 60000 } });
  await c.fetch('k', async () => 'v1'); // prime the entry
  await sleep(50); // now stale, still inside swr
  let resolveFetch;
  const p = c.fetch('k', () => new Promise((r) => { resolveFetch = r; })); // stale serve + background refetch
  await sleep(5); // fetcher is now in flight
  c.invalidate('k'); // invalidated while the fetcher is running
  resolveFetch('obsolete-value');
  assert.equal(await p, 'v1', 'SWR caller was served the stale value synchronously');
  await sleep(5);
  assert.equal(c.size(), 0, 'the invalidated entry must not be resurrected');
  assert.equal(c.get('k'), undefined);
});

test('race: foreground revalidate after invalidation does not resurrect either', async () => {
  const c = createFreshl();
  c.set('k', 'v0');
  c.delete('k');
  let resolveFetch;
  const p = c.fetch('k', () => new Promise((r) => { resolveFetch = r; })); // cold miss, in flight
  await sleep(5);
  c.invalidate('k');
  resolveFetch('v1');
  assert.equal(await p, 'v1');
  // no invalidation happened while in flight for an absent key: entry is stored normally
  assert.equal(c.get('k'), 'v1');
});

test('stats: SWR serve is a hit, failed background revalidation is not a miss', async () => {
  const c = createFreshl({ defaultPolicy: { ttl: 20, swr: 60000, staleIfError: 60000 } });
  await c.fetch('k', async () => 'ok'); // miss
  await sleep(40); // stale
  const failing = async () => { await sleep(5); throw new Error('net'); };
  assert.equal(await c.fetch('k', failing), 'ok', 'stale served instantly');
  await sleep(10); // background revalidation fails
  assert.equal(c.peek('k'), 'ok', 'staleIfError keeps the value');
  const s = c.stats();
  assert.equal(s.misses, 1); // only the cold fetch
  assert.equal(s.hits, 1); // the SWR instant serve
});

test('cascade indexes stay consistent after set replaces an entry', () => {
  const c = createFreshl();
  c.set('user:1', {});
  c.set('feed', {}, { dependsOn: ['user:1'] });
  c.set('feed', {}, { dependsOn: { tags: ['users'] } }); // deps changed
  let hit = c.invalidate('user:1');
  assert.deepEqual(hit, ['user:1'], 'old dep must be dropped on overwrite');
  hit = c.invalidate({ tags: ['users'] });
  assert.deepEqual(hit, ['feed'], 'new dep must work');
});

test('storage: true uses the global localStorage', async () => {
  // fake global localStorage (Node has none)
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i],
    get length() { return store.size; },
  };
  try {
    const c1 = createFreshl({ storage: true, defaultPolicy: { ttl: 60000 } });
    c1.set('a', 1, { tags: ['t'] });
    assert.ok(store.size > 0, 'entry must be persisted');
    const c2 = createFreshl({ storage: true });
    assert.equal(c2.get('a'), 1, 'hydrated from global localStorage');
  } finally {
    delete globalThis.localStorage;
  }
});

test('hydration restores dependency cascade for persisted entries', async () => {
  const storage = new MemoryStorage();
  const c1 = createFreshl({ storage, defaultPolicy: { ttl: 60000 } });
  c1.set('user:1', {});
  c1.set('feed', {}, { dependsOn: { tags: ['users'] } });
  c1.set('user:1', {}, { tags: ['users'] });
  const c2 = createFreshl({ storage });
  assert.equal(c2.get('feed') !== undefined, true, 'feed hydrated');
  const hit = c2.invalidate({ tags: ['users'] });
  assert.deepEqual(hit.sort(), ['feed', 'user:1'],
    'cascade must work over hydrated dependencies');
});

test('off() accepts the same object target that on() received', () => {
  const c = createFreshl();
  const log = [];
  const target = { tags: ['users'], events: ['changed'] };
  const handler = (m) => log.push(m);
  c.on(target, handler);
  c.emit('changed');
  assert.equal(log.length, 1);
  c.off(target, handler);
  c.emit('changed');
  assert.equal(log.length, 1, 'object-target subscription removed via off()');
});
