# freshl — API reference

- [Factory and options](#factory-and-options)
- [Policies](#policies)
- [Manual mode: set / get / peek / has / meta](#manual-mode)
- [Fetcher mode: fetch](#fetcher-mode)
- [Invalidation: invalidate](#invalidation)
- [Events: bindEvent / emit](#events)
- [Subscribers: on / off](#subscribers)
- [Instrumentation: stats / resetStats](#instrumentation)
- [Persistence: storage adapters](#persistence)
- [Cache inspection and admin](#cache-inspection-and-admin)
- [Message types](#message-types)

API на русском: [api.ru.md](./api.ru.md)

## Factory and options

```js
import { createFreshl } from '@micusion/freshl';
const cache = createFreshl(options);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultPolicy` | `object` | `{ ttl: 300000 }` | Policy applied to every entry unless overridden per entry. |
| `maxEntries` | `number` | `Infinity` | Enables LRU eviction of the least recently used entries. |
| `storage` | `true \| Storage \| adapter` | `null` | Persistence: `true` uses global `localStorage`; or pass a Storage-like object; or any `{ get, set, del, keys }` adapter. |
| `namespace` | `string` | `'freshl'` | Key prefix used in the storage. |
| `serialize` / `deserialize` | `function` | JSON | Hooks for non-JSON values (e.g. structuredClone, custom codecs). |

## Policies

Every entry carries a policy; per-entry values override `defaultPolicy`.

| Field | Default | Meaning |
|---|---|---|
| `ttl` | `300000` (5 min) | How long the value counts as fresh, ms. |
| `swr` | `0` | Stale-while-revalidate window: after `ttl` the stale value is served instantly and revalidated in the background, ms. |
| `staleIfError` | `0` | After `ttl`, still serve stale if the fetcher fails, for this long counting from store time, ms. |
| `persist` | `true` | Whether the entry is written to the storage adapter (if configured). |

Timeline for `ttl: 30s, swr: 5m, staleIfError: 10m`:

```
stored        +30s            +5m30s                +10m30s
   │ fresh      │ stale (swr)   │ dead (swr over)     │ dead even on error
```

## Manual mode

```js
cache.set(key, value, opts?)   // store; opts: { policy, tags, dependsOn }
cache.get(key)                 // value if alive (ttl/swr/staleIfError), else undefined
cache.peek(key)                // value regardless of freshness
cache.has(key)                 // alive?
cache.meta(key)                // FreshlMeta | null
```

`get()` is pure — it never triggers a network call; revalidation happens only
through [`fetch()`](#fetcher-mode). `meta()` returns age, freshness, tags,
dependencies, policy copy and hit counter without touching LRU bookkeeping.

## Fetcher mode

```js
const value = await cache.fetch(key, fetcher, opts?);
```

Behaviour:

1. **Fresh hit** — returns the value synchronously (counted as a hit in stats).
2. **Stale inside `swr`** — returns the stale value instantly and starts a
   background revalidation; the refreshed value is announced to key subscribers
   with `{ type: 'refresh' }`.
3. **Miss / expired** — awaits the fetcher (counted as a miss).
4. **Fetcher fails while `staleIfError` covers the entry** — returns the stale value.
5. **Concurrent calls for the same key** — share one in-flight promise.
6. **Invalidation race** — if the key is invalidated while the fetcher runs, the
   result is discarded instead of resurrecting the dead entry.

## Invalidation

```js
const killed = cache.invalidate(target, opts?);
// target: 'key' | ['k1','k2'] | { keys: [...], tags: [...] }
// opts:   { cascade: true (default), reason: 'manual' }
// returns the list of invalidated keys
```

- **Keys** — direct removal.
- **Tags** — removes every entry registered with that tag (`set(k, v, { tags: ['users'] })`).
- **Cascade** — transitively removes everything that `dependsOn` the invalidated
  keys/tags, using reverse dependency indexes (O(reachable keys)).
- Disabled per call with `{ cascade: false }`.

Dependencies are declared per entry:

```js
cache.set('feed', feed, { dependsOn: ['profile:1'] });            // depends on a key
cache.set('feed', feed, { dependsOn: { tags: ['users'] } });      // depends on a tag
cache.set('feed', feed, { dependsOn: { keys: ['a'], tags: ['users'] } });
```

See the dedicated guide: [invalidation.md](./invalidation.md).

## Events

```js
cache.bindEvent(name, rule);   // rule: { keys?, tags?, resolve?, cascade? }
cache.unbindEvent(name);
cache.emit(name, payload?)     // → list of invalidated keys
```

A static rule invalidates fixed targets:

```js
cache.bindEvent('user:updated', { tags: ['users'] });
cache.emit('user:updated', { id: 42 }); // kills every 'users'-tagged entry
```

A `resolve` rule computes targets from the payload — invalidate exactly what changed:

```js
cache.bindEvent('dataset:updated', {
  resolve: (payload) => ({ keys: payload.names.map((n) => 'dataset:' + n) }),
});
cache.emit('dataset:updated', { names: ['alpha', 'beta'] }); // only dataset:alpha, dataset:beta
```

`emit()` notifies `event:<name>` subscribers with
`{ type: 'event', name, payload, invalidated }`.

## Subscribers

```js
const off = cache.on('key:user:1', cb);    // set / refresh / invalidate / delete / stale-error
cache.on('tag:users', cb);                 // invalidation of the tag
cache.on('event:ordered', cb);             // domain events
cache.on('invalidate', cb);                // global invalidation stream
cache.on({ keys: ['feed'], tags: ['users'], events: ['ordered'] }, cb); // several at once

off();                                     // unsubscribe
cache.off(target, handler);                // same targets as on(), including object form
```

`on()` always returns an unsubscribe function. The object form is registered as a
whole, so `off({ tags: ['users'] }, handler)` removes exactly that subscription.

## Instrumentation

```js
cache.stats();
// {
//   hits, misses, network, sets, invalidations, invalidatedKeys, evictions,
//   hitRate,            // hits / (hits+misses), null before the first read
//   avgHitLatency,      // ms; a hit is any read served without awaiting the network
//   avgMissLatency      // ms; a miss awaited the fetcher (including failed ones covered by staleIfError)
// }

cache.resetStats(); // zeroes counters, keeps entries
```

Notes on semantics:

- A stale-while-revalidate serve is a **hit** (the caller did not wait); its
  background revalidation is not counted as a read.
- `network` counts fetcher invocations; in-flight dedupe collapses concurrent
  calls into one.
- `get()`/`peek()` do not affect stats — only the `fetch()` path is instrumented.

## Persistence

```js
createFreshl({ storage: true, namespace: 'myapp', defaultPolicy: { ttl: 300000 } });
createFreshl({ storage: localStorage });                          // same as true
createFreshl({ storage: myAdapter });                             // { get, set, del, keys }
createFreshl({ storage: new MemoryStorage() });                   // built-in in-memory adapter
createFreshl({ storage: new LocalStorageAdapter(otherStorage) }); // wrap any Storage
```

- Entries are written through on `set()` and removed on invalidation/eviction.
- On construction, stored entries are hydrated; entries that fully expired
  (beyond both `swr` and `staleIfError`) are dropped instead of resurrected.
- The shipped adapters: `MemoryStorage`, `LocalStorageAdapter`. Both degrade
  gracefully when the underlying storage is unavailable.

## Cache inspection and admin

```js
cache.keys();      // all keys (LRU order: least recent first)
cache.entries();   // FreshlMeta[] for every entry
cache.size();      // entry count
cache.delete(key); // remove one entry → boolean
cache.clear();     // remove everything → list of removed keys
```

## Message types

Subscribers receive one of these payloads:

| Channel | Payload |
|---|---|
| `key:<k>` | `{ type: 'set' \| 'refresh' \| 'invalidate' \| 'delete' \| 'stale-error', key, value?, error? }` |
| `tag:<t>` | `FreshlInvalidationPayload` `{ keys, tags, reason }` |
| `event:<name>` | `{ type: 'event', name, payload, invalidated }` |
| `invalidate` | `FreshlInvalidationPayload` |
| `evict` | `{ key, entry }` — LRU eviction notice |
