# freshl — справочник API

- [Фабрика и опции](#фабрика-и-опции)
- [Политики](#политики)
- [Ручной режим: set / get / peek / has / meta](#ручной-режим)
- [Режим с fetcher: fetch](#режим-с-fetcher)
- [Инвалидация: invalidate](#инвалидация)
- [События: bindEvent / emit](#события)
- [Подписчики: on / off](#подписчики)
- [Инструментация: stats / resetStats](#инструментация)
- [Персистентность: адаптеры хранилища](#персистентность)
- [Инспекция и администрирование](#инспекция-и-администрирование)
- [Типы сообщений](#типы-сообщений)

English version: [api.md](./api.md)

## Фабрика и опции

```js
import { createFreshl } from '@micusion/freshl';
const cache = createFreshl(options);
```

| Опция | Тип | По умолчанию | Описание |
|---|---|---|---|
| `defaultPolicy` | `object` | `{ ttl: 300000 }` | Политика для всех записей, если не переопределена на запись. |
| `maxEntries` | `number` | `Infinity` | Включает LRU-вытеснение давно используемых записей. |
| `storage` | `true \| Storage \| адаптер` | `null` | Персистентность: `true` — глобальный `localStorage`; либо Storage-подобный объект; либо адаптер `{ get, set, del, keys }`. |
| `namespace` | `string` | `'freshl'` | Префикс ключей в хранилище. |
| `serialize` / `deserialize` | `function` | JSON | Хуки для не-JSON значений. |

## Политики

Каждая запись несёт политику; значения на записи переопределяют `defaultPolicy`.

| Поле | По умолчанию | Смысл |
|---|---|---|
| `ttl` | `300000` (5 мин) | Сколько данные считаются свежими, мс. |
| `swr` | `0` | Окно stale-while-revalidate: после `ttl` стейл отдаётся мгновенно и ревалидируется в фоне, мс. |
| `staleIfError` | `0` | После `ttl` отдавать стейл при ошибке fetcher'а в течение этого времени с момента записи, мс. |
| `persist` | `true` | Писать ли запись в адаптер хранилища (если подключён). |

Таймлайн для `ttl: 30с, swr: 5м, staleIfError: 10м`:

```
запись       +30с          +5м30с               +10м30с
   │ свежий    │ стейл (swr) │ мёртв (swr кончился) │ мёртв даже при ошибке
```

## Ручной режим

```js
cache.set(key, value, opts?)   // записать; opts: { policy, tags, dependsOn }
cache.get(key)                 // значение, если жива (ttl/swr/staleIfError), иначе undefined
cache.peek(key)                // значение без проверки свежести
cache.has(key)                 // жива?
cache.meta(key)                // FreshlMeta | null
```

`get()` чист — сетевых вызовов не делает; ревалидация происходит только через
[`fetch()`](#режим-с-fetcher). `meta()` возвращает возраст, свежесть, теги,
зависимости, копию политики и счётчик обращений.

## Режим с fetcher

```js
const value = await cache.fetch(key, fetcher, opts?);
```

Поведение:

1. **Свежее попадание** — значение возвращается синхронно (в статистике — hit).
2. **Стейл внутри `swr`** — стейл отдаётся мгновенно, запускается фоновая
   ревалидация; новое значение анонсируется подписчикам ключа событием
   `{ type: 'refresh' }`.
3. **Промах / истекла** — ожидание fetcher'а (в статистике — miss).
4. **Fetcher упал, а `staleIfError` покрывает запись** — возвращается стейл.
5. **Одновременные вызовы одного ключа** — делят один in-flight промис.
6. **Гонка с инвалидацией** — если ключ инвалидировали во время запроса,
   результат отбрасывается, а не воскрешает мёртвую запись.

## Инвалидация

```js
const killed = cache.invalidate(target, opts?);
// target: 'key' | ['k1','k2'] | { keys: [...], tags: [...] }
// opts:   { cascade: true (по умолчанию), reason: 'manual' }
// возвращает список инвалидированных ключей
```

- **Ключи** — прямое удаление.
- **Теги** — удаляет все записи с тегом (`set(k, v, { tags: ['users'] })`).
- **Каскад** — транзитивно удаляет всё, что `dependsOn` инвалидированных
  ключей/тегов, по обратным индексам (O(достижимых ключей)).
- Отключается на вызов: `{ cascade: false }`.

Зависимости объявляются на запись:

```js
cache.set('feed', feed, { dependsOn: ['profile:1'] });            // зависимость от ключа
cache.set('feed', feed, { dependsOn: { tags: ['users'] } });      // от тега
cache.set('feed', feed, { dependsOn: { keys: ['a'], tags: ['users'] } });
```

Отдельный гайд: [invalidation.ru.md](./invalidation.ru.md).

## События

```js
cache.bindEvent(name, rule);   // rule: { keys?, tags?, resolve?, cascade? }
cache.unbindEvent(name);
cache.emit(name, payload?)     // → список инвалидированных ключей
```

Статическое правило инвалидирует фиксированные цели:

```js
cache.bindEvent('user:updated', { tags: ['users'] });
cache.emit('user:updated', { id: 42 }); // убивает все записи с тегом users
```

Правило с `resolve` вычисляет цели из payload — инвалидация ровно того, что изменилось:

```js
cache.bindEvent('dataset:updated', {
  resolve: (payload) => ({ keys: payload.names.map((n) => 'dataset:' + n) }),
});
cache.emit('dataset:updated', { names: ['alpha', 'beta'] }); // только dataset:alpha, dataset:beta
```

`emit()` уведомляет подписчиков `event:<name>` сообщением
`{ type: 'event', name, payload, invalidated }`.

## Подписчики

```js
const off = cache.on('key:user:1', cb);    // set / refresh / invalidate / delete / stale-error
cache.on('tag:users', cb);                 // инвалидация тега
cache.on('event:ordered', cb);             // доменные события
cache.on('invalidate', cb);                // глобальный поток инвалидаций
cache.on({ keys: ['feed'], tags: ['users'], events: ['ordered'] }, cb); // несколько сразу

off();                                     // отписка
cache.off(target, handler);                // те же цели, что у on(), включая объектную форму
```

`on()` всегда возвращает функцию отписки. Объектная цель регистрируется целиком,
поэтому `off({ tags: ['users'] }, handler)` снимает именно эту подписку.

## Инструментация

```js
cache.stats();
// {
//   hits, misses, network, sets, invalidations, invalidatedKeys, evictions,
//   hitRate,            // hits / (hits+misses), null до первого чтения
//   avgHitLatency,      // мс; hit — любое чтение, отданное без ожидания сети
//   avgMissLatency      // мс; miss — чтение, ожидавшее fetcher (включая неудачи под staleIfError)
// }

cache.resetStats(); // обнуляет счётчики, записи не трогает
```

Семантика:

- SWR-выдача стейла — это **hit** (вызывающий не ждал); её фоновая ревалидация
  чтением не считается.
- `network` считает вызовы fetcher'а; дедупликация сворачивает параллельные вызовы в один.
- `get()`/`peek()` на статистику не влияют — инструментирован только путь `fetch()`.

## Персистентность

```js
createFreshl({ storage: true, namespace: 'myapp', defaultPolicy: { ttl: 300000 } });
createFreshl({ storage: localStorage });                          // то же, что true
createFreshl({ storage: myAdapter });                             // { get, set, del, keys }
createFreshl({ storage: new MemoryStorage() });                   // встроенный адаптер в памяти
createFreshl({ storage: new LocalStorageAdapter(otherStorage) }); // обёртка над любым Storage
```

- Записи пишутся сквозь при `set()` и удаляются при инвалидации/вытеснении.
- При конструировании записи гидратируются; полностью протухшие (за пределами и
  `swr`, и `staleIfError`) не воскрешаются.
- Адаптеры в комплекте: `MemoryStorage`, `LocalStorageAdapter`. Оба деградируют
  тихо, если хранилище недоступно.

## Инспекция и администрирование

```js
cache.keys();      // все ключи (порядок LRU: давно используемые в начале)
cache.entries();   // FreshlMeta[] по всем записям
cache.size();      // количество записей
cache.delete(key); // удалить одну запись → boolean
cache.clear();     // удалить всё → список удалённых ключей
```

## Типы сообщений

Подписчики получают один из этих payload'ов:

| Канал | Payload |
|---|---|
| `key:<k>` | `{ type: 'set' \| 'refresh' \| 'invalidate' \| 'delete' \| 'stale-error', key, value?, error? }` |
| `tag:<t>` | `FreshlInvalidationPayload` `{ keys, tags, reason }` |
| `event:<name>` | `{ type: 'event', name, payload, invalidated }` |
| `invalidate` | `FreshlInvalidationPayload` |
| `evict` | `{ key, entry }` — уведомление о LRU-вытеснении |
