# freshl — invalidation guide

How freshl decides what to kill, and when. API details live in
[api.md](./api.md); this guide is about the mental model and recipes.

## The three invalidation primitives

| Primitive | Declared | Kills |
|---|---|---|
| **Key** | — | one entry |
| **Tag** | `set(k, v, { tags: ['users'] })` | every entry carrying the tag |
| **Dependency** | `set(k, v, { dependsOn: ... })` | the entry itself, when its dependency dies (transitively) |

Tags answer *“what is this data about?”*. Dependencies answer *“what is this
data derived from?”*. Both cascade, both are cheap: lookups go through reverse
indexes, not full scans.

## Recipe: partial update after a mutation

The most common app flow — a server mutation invalidates exactly what changed:

```js
const cache = createFreshl({ defaultPolicy: { ttl: 5000, swr: 30000 } });

// 1. load a catalogue, tag it
cache.fetch('catalog', fetchCatalog, { tags: ['catalog'] });
cache.fetch('item:42', fetchItem, { tags: ['catalog'] });

// 2. declare the event once: resolve maps payload → exact keys
cache.bindEvent('item:restocked', {
  resolve: (payload) => ({ keys: payload.ids.map((id) => `item:${id}`) }),
});

// 3. after a successful mutation on the server, emit with the facts
await api.restock(42);
cache.emit('item:restocked', { ids: [42] });
// → item:42 invalidated, catalog stays; nothing over-fetched
```

Why not invalidate the whole tag? You can — `invalidate({ tags: ['catalog'] })`
— but then every derived entry refetches even if its inputs did not change.
`resolve` rules keep invalidation surgical.

## Recipe: derived data via dependencies

When an entry is computed *from* other entries, declare it and let the cascade
do the work:

```js
cache.set('user:1', user, { tags: ['users'] });
cache.set('profile:1', profile, { dependsOn: { tags: ['users'] } });
cache.set('feed', feed, { dependsOn: ['profile:1'] }); // chained, transitive

cache.invalidate({ tags: ['users'] });
// → ['user:1', 'profile:1', 'feed']
```

Disable the chain when you only want the direct hit:

```js
cache.invalidate('user:1', { cascade: false }); // profile:1 and feed survive
```

## Recipe: auto-refresh subscribers

The third pillar — who receives fresh data. Pair an invalidation subscription
with re-fetching, and the UI heals itself after any invalidation source:

```js
const rendered = new Set(['catalog', 'item:42']);

cache.on('invalidate', ({ keys }) => {
  for (const key of keys) {
    if (rendered.has(key)) cache.fetch(key, () => refetch(key)); // whatever is on screen
  }
});
```

Combined with `resolve` rules this gives: server mutation → one event →
surgical invalidation → automatic re-fetch of exactly the visible entries.

## Interaction with SWR

Invalidation removes entries immediately — a stale-but-usable entry is still a
*live* entry until invalidated. Two consequences:

1. An in-flight background revalidation started before the invalidation will
   **discard** its result (generation guard) — the dead entry stays dead.
2. After invalidation the next `fetch()` is a cold miss; subscribers see
   `{ type: 'invalidate' }` and then `{ type: 'refresh' }` when data arrives.

## Choosing a `reason`

Every invalidation carries a reason: `'manual'` by default, `'event:<name>'`
when triggered by `emit()`. Use it to route subscriber logic:

```js
cache.on('invalidate', ({ keys, reason }) => {
  if (reason === 'event:item:restocked') updateBadges(keys);
  else fullRerender(keys);
});
```

## Persistence

Invalidation also deletes the persisted copy of the entry (storage adapters
receive `del(key)`), so a page reload cannot resurrect killed data. Fully
expired entries are dropped during hydration for the same reason.
