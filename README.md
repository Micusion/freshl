# freshl

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-27%2F27-brightgreen.svg)](#development)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](./package.json)
[![Size](https://img.shields.io/badge/gzip-6.3%20KB-informational.svg)](#development)
[![TypeScript](https://img.shields.io/badge/types-included-3178c6.svg)](./index.d.ts)

**Client-side cache with smart invalidation.** Pure JavaScript, zero dependencies, Apache 2.0.

Read this in [Русский](./README.ru.md).

freshl answers the three hard questions of client-side caching:

1. **Caching policy** — TTL, stale-while-revalidate, stale-if-error, LRU eviction.
2. **Invalidation** — by keys, human-readable tags (`users`, `orders`), domain events
   (`user:updated`) and dependency cascades (`feed` depends on `users` → dies with it).
3. **Subscribers** — who gets fresh data and when: watch a key, a tag, an event,
   or the global invalidation stream.

```js
import { createFreshl } from 'freshl';

const cache = createFreshl({
  defaultPolicy: { ttl: 60_000, swr: 300_000 }, // fresh 1 min, then SWR for 5 min
  maxEntries: 500,                              // LRU
});

// manual mode
cache.set('user:1', user, { tags: ['users'] });
cache.get('user:1');

// fetcher mode (SWR + in-flight dedupe)
const user = await cache.fetch('user:1', () => api.getUser(1), {
  tags: ['users'],
  policy: { ttl: 30_000, staleIfError: 600_000 },
});

// invalidate exactly what changed
cache.bindEvent('user:updated', {
  resolve: (payload) => ({ keys: payload.ids.map((id) => `user:${id}`) }),
});
cache.emit('user:updated', { ids: [42] });

// subscribe: re-fetch invalidated keys automatically
cache.on('invalidate', ({ keys }) => keys.forEach(refetch));
```

## Features

- **Policies** — `ttl` / `swr` / `staleIfError` globally and per entry; LRU via `maxEntries`.
- **SWR fetcher mode** — serves stale instantly, revalidates in the background, dedupes
  concurrent calls into one in-flight promise.
- **Race-safe** — a fetcher result is discarded if its key was invalidated while the
  request was running (no resurrection of dead entries).
- **Tag invalidation** — kill everything tagged `users` in one call.
- **Dependency cascades** — `dependsOn` keys/tags, transitive, O(reachable keys).
- **Domain events** — `bindEvent('order:cancelled', { tags: ['orders'] })`, with
  `resolve` rules that compute targets from the event payload.
- **Subscribers** — `on()` a key, tag, event, several targets at once, or the global
  invalidation stream; always returns an unsubscribe function.
- **Built-in instrumentation** — `cache.stats()`: hit rate, average hit/miss latency,
  network calls, invalidations, evictions.
- **Optional persistence** — global `localStorage`, a Storage-like object, or any
  `{ get, set, del, keys }` adapter; fully expired entries are not resurrected.
- **Zero dependencies, single file** — ~23 KB source, ~6.3 KB gzipped; ESM + UMD + CJS.

## Installation

```bash
npm install freshl   # or just copy src/freshl.js
```

```html
<!-- UMD via script tag: global `Freshl` -->
<script src="dist/freshl.umd.js"></script>
```

TypeScript types are included (`index.d.ts`).

## Documentation

- [API reference](./docs/api.md) — every method, option and event, with examples
- [Invalidation guide](./docs/invalidation.md) — tags, dependencies, events, resolve rules
- [Live demo](./demo/) — a benchmark page served by `npm run demo`
- [Русская версия README](./README.ru.md), [API на русском](./docs/api.ru.md)

## Development

```bash
npm test          # node --test, 27 tests
npm run build     # dist/freshl.esm.js, dist/freshl.umd.js, dist/freshl.umd.cjs
npm run demo      # demo server → http://localhost:8080
```

### CI

GitHub Actions runs tests on Node 20/22/24, rebuilds `dist/` and fails if the
committed bundle drifted from `src/freshl.js` ([workflow](./.github/workflows/ci.yml)).

Skip the whole pipeline by adding a marker to the commit message or PR title
(case-insensitive): **`[no-CI]`**, `[no ci]`, `[skip-ci]`, `[skip ci]`, `[ci-skip]`.

```bash
git commit -m "docs: typo in readme [no-CI]"   # CI will be skipped
```

## License

[Apache License 2.0](./LICENSE) © 2026 Micusion
