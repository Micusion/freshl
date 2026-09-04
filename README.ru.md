# freshl

[![npm](https://img.shields.io/npm/v/@micusion/freshl.svg)](https://www.npmjs.com/package/@micusion/freshl)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-27%2F27-brightgreen.svg)](#разработка)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](./package.json)
[![Size](https://img.shields.io/badge/gzip-6.3%20KB-informational.svg)](#разработка)
[![TypeScript](https://img.shields.io/badge/types-included-3178c6.svg)](./index.d.ts)

**Клиентский кэш с умной инвалидацией.** Чистый JavaScript, ноль зависимостей, Apache 2.0.

Read this in [English](./README.md).

freshl закрывает три сложных вопроса клиентского кэширования:

1. **Политика кэширования** — TTL, stale-while-revalidate, stale-if-error, LRU-вытеснение.
2. **Инвалидация** — по ключам, человеко-читаемым тегам (`users`, `orders`), доменным
   событиям (`user:updated`) и каскадам по зависимостям (`feed` зависит от `users` → умирает вместе с ним).
3. **Подписчики** — кто и когда получает свежие данные: на ключ, тег, событие
   или глобальный поток инвалидаций.

```js
import { createFreshl } from '@micusion/freshl';

const cache = createFreshl({
  defaultPolicy: { ttl: 60_000, swr: 300_000 }, // свежий 1 мин, потом SWR 5 мин
  maxEntries: 500,                              // LRU
});

// ручной режим
cache.set('user:1', user, { tags: ['users'] });
cache.get('user:1');

// режим с fetcher (SWR + дедупликация запросов)
const user = await cache.fetch('user:1', () => api.getUser(1), {
  tags: ['users'],
  policy: { ttl: 30_000, staleIfError: 600_000 },
});

// инвалидируем ровно то, что изменилось
cache.bindEvent('user:updated', {
  resolve: (payload) => ({ keys: payload.ids.map((id) => `user:${id}`) }),
});
cache.emit('user:updated', { ids: [42] });

// подписка: автоматически перечитываем инвалидированные ключи
cache.on('invalidate', ({ keys }) => keys.forEach(refetch));
```

## Возможности

- **Политики** — `ttl` / `swr` / `staleIfError` глобально и на запись; LRU через `maxEntries`.
- **SWR-режим с fetcher** — мгновенно отдаёт стейл, ревалидирует в фоне,
  сворачивает одновременные вызовы в один in-flight промис.
- **Защита от гонок** — результат fetcher'а отбрасывается, если ключ успели
  инвалидировать во время запроса (мертвецы не воскресают).
- **Инвалидация по тегам** — одним вызовом убить всё с тегом `users`.
- **Каскады зависимостей** — `dependsOn` на ключи/теги, транзитивно, O(достижимых ключей).
- **Доменные события** — `bindEvent('order:cancelled', { tags: ['orders'] })`,
  в том числе `resolve`-правила, вычисляющие цели из payload события.
- **Подписчики** — `on()` на ключ, тег, событие, несколько целей сразу или
  глобальный поток инвалидаций; всегда возвращает функцию отписки.
- **Встроенная инструментация** — `cache.stats()`: hit rate, средние латентности
  попаданий/промахов, сетевые вызовы, инвалидации, вытеснения.
- **Опциональная персистентность** — глобальный `localStorage`, Storage-подобный
  объект или любой адаптер `{ get, set, del, keys }`; полностью протухшие записи не воскрешаются.
- **Ноль зависимостей, один файл** — ~23 КБ исходник, ~6.3 КБ gzip; ESM + UMD + CJS.

## Установка

```bash
npm install @micusion/freshl   # или просто скопируйте src/freshl.js
```

```html
<!-- UMD через script-тег: глобальная переменная `Freshl` -->
<script src="dist/freshl.umd.js"></script>
```

TypeScript-типы входят в пакет (`index.d.ts`).

## Документация

- [Справочник API](./docs/api.ru.md) — все методы, опции и события с примерами
- [Гайд по инвалидации](./docs/invalidation.ru.md) — теги, зависимости, события, resolve-правила
- [Живое демо](./demo/) — страница замеров, запускается через `npm run demo`
- [English README](./README.md), [API in English](./docs/api.md)

## Разработка

```bash
npm test          # node --test, 27 тестов
npm run build     # dist/freshl.esm.js, dist/freshl.umd.js, dist/freshl.umd.cjs
npm run demo      # демо-сервер → http://localhost:8080
```

### CI

GitHub Actions гоняет тесты на Node 20/22/24, пересобирает `dist/` и падает,
 если закоммиченный бандл разошёлся с `src/freshl.js` ([workflow](./.github/workflows/ci.yml)).

Пропустить весь пайплайн можно маркером в сообщении коммита или заголовке PR
(регистр не важен): **`[no-CI]`**, `[no ci]`, `[skip-ci]`, `[skip ci]`, `[ci-skip]`.

```bash
git commit -m "docs: опечатка в ридми [no-CI]"   # CI будет пропущен
```

## Лицензия

[Apache License 2.0](./LICENSE) © 2026 Micusion
