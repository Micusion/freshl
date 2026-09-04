# freshl demo

A benchmark page: the server ships six heavy garbage datasets (~230 KB JSON each,
80–200 ms artificial latency), the page caches them with freshl and shows
`cache.stats()` live.

```bash
npm run demo   # from the repo root → http://localhost:8080
# or: node demo/server.mjs
```

## Scenarios

| Button | What it exercises |
|---|---|
| **Load all** | cold misses, parallel fetches |
| **Re-read all** | hits (0 ms) vs the cold numbers |
| **Server updates alpha & beta** | human-readable API `POST /api/datasets/:name/update` → domain event `dataset:updated` with a `resolve` rule → only 2 keys invalidated, auto-refreshed by a subscriber |
| **Invalidate tag "datasets"** | tag invalidation + cascade |
| **Stress: 50 parallel reads** | in-flight dedupe, hit rate |

## API (human-readable routes)

```
GET  /api/datasets               → [{ name, version }, ...]
GET  /api/datasets/:name         → { dataset, version, data }  (~230 KB)
POST /api/datasets/:name/update  → { dataset, version, mutatedAt }
```

Zero dependencies: `node:http` only.
