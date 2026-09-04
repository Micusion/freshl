(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Freshl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
/*!
 * freshl — client-side cache with smart invalidation.
 * Licensed under the Apache License, Version 2.0.
 */

/** Default entry policy (all durations in ms). */
const DEFAULT_POLICY = Object.freeze({
  ttl: 5 * 60 * 1000,        // fresh for this long
  swr: 0,                    // after ttl, serve stale while revalidating in background
  staleIfError: 0,           // after ttl, still serve stale if fetcher fails (for this long)
  persist: true,             // subject to storage persistence (if a storage is configured)
});

const EV_PREFIX = 'event:';
const TAG_PREFIX = 'tag:';
const KEY_PREFIX = 'key:';

function now() {
  return Date.now();
}

function perf() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function asSet(list) {
  return list && list.length ? new Set(Array.isArray(list) ? list : [list]) : new Set();
}

function normalizePolicy(policy) {
  return Object.assign({}, DEFAULT_POLICY, policy || {});
}

/**
 * Simple in-memory storage adapter. Serves as the reference implementation
 * of the StorageAdapter interface: get(key), set(key, text), del(key), keys().
 */
class MemoryStorage {
  constructor() {
    this._map = new Map();
  }
  get(key) {
    return this._map.has(key) ? this._map.get(key) : null;
  }
  set(key, text) {
    this._map.set(key, String(text));
  }
  del(key) {
    this._map.delete(key);
  }
  keys() {
    return Array.from(this._map.keys());
  }
}

/**
 * Adapter over localStorage (or anything with the Web Storage interface).
 * Reads are defensive: a broken/unavailable storage degrades to no persistence.
 */
class LocalStorageAdapter {
  constructor(storage) {
    this._storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  }
  get(key) {
    try {
      const v = this._storage && this._storage.getItem(key);
      return v === null || v === undefined ? null : v;
    } catch {
      return null;
    }
  }
  set(key, text) {
    try {
      this._storage && this._storage.setItem(key, String(text));
    } catch {
      /* quota exceeded or storage unavailable — persistence is best-effort */
    }
  }
  del(key) {
    try {
      this._storage && this._storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  keys() {
    try {
      if (!this._storage) return [];
      const out = [];
      for (let i = 0; i < this._storage.length; i++) out.push(this._storage.key(i));
      return out;
    } catch {
      return [];
    }
  }
}

class Emitter {
  constructor() {
    this._handlers = new Map(); // target string -> Set<fn>
    this._any = new Set();
  }
  on(target, fn) {
    if (!this._handlers.has(target)) this._handlers.set(target, new Set());
    this._handlers.get(target).add(fn);
    return () => this.off(target, fn);
  }
  onAny(fn) {
    this._any.add(fn);
    return () => this._any.delete(fn);
  }
  off(target, fn) {
    const set = this._handlers.get(target);
    if (set) set.delete(fn);
  }
  emit(target, payload) {
    const set = this._handlers.get(target);
    if (set) for (const fn of Array.from(set)) fn(payload);
    for (const fn of Array.from(this._any)) fn(target, payload);
  }
  listenerCount(target) {
    if (target === undefined) return this._any.size;
    return (this._handlers.get(target) || new Set()).size;
  }
}

class Freshl {
  constructor(options = {}) {
    this._options = options;
    this._defaultPolicy = normalizePolicy(options.defaultPolicy);
    this._maxEntries = options.maxEntries > 0 ? options.maxEntries : Infinity;
    this._entries = new Map();       // key -> entry (insertion order used for LRU)
    this._inFlight = new Map();      // key -> Promise (fetch deduplication)
    this._bus = new Emitter();       // subscribers
    this._objectSubs = new Map();    // object-target id -> Map<handler, unsubs>
    this._events = new Emitter();    // user event bus
    this._eventBindings = new Map(); // event name -> [{ keys, tags, cascade }]
    this._tagIndex = new Map();      // tag -> Set<key>
    this._depsByKey = new Map();     // dep key -> Set<keys that depend on it>
    this._depsByTag = new Map();     // dep tag -> Set<keys that depend on it>
    this._generations = new Map();   // key -> counter, bumped on delete/invalidate:
                                     // lets an in-flight revalidate detect that its
                                     // result is obsolete and must not be stored
    this._stats = {
      hits: 0, hitMs: 0,             // served from cache (fresh or stale-while-revalidate)
      misses: 0, missMs: 0,          // had to await the fetcher
      network: 0,                    // fetcher invocations (in-flight dedupe counts once)
      sets: 0,
      invalidations: 0, invalidatedKeys: 0,
      evictions: 0,
    };
    this._namespace = options.namespace || 'freshl';
    this._serialize = options.serialize || JSON.stringify;
    this._deserialize = options.deserialize || JSON.parse;
    this._storage = null;
    if (options.storage) {
      this._storage =
        typeof options.storage === 'object' && typeof options.storage.get === 'function'
          ? options.storage
          : new LocalStorageAdapter(options.storage === true ? null : options.storage);
      this._hydrate();
    }
  }

  /* ------------------------------------------------------------------ *
   * Core: set / get / has / delete
   * ------------------------------------------------------------------ */

  /**
   * Store a value manually.
   * @param {string} key
   * @param {*} value
   * @param {object} [opts]
   * @param {object} [opts.policy]   { ttl, swr, staleIfError, persist }
   * @param {string[]|string} [opts.tags]    human-readable invalidation tags
   * @param {string[]|string} [opts.dependsOn]  keys/tags this entry depends on
   */
  set(key, value, opts = {}) {
    const policy = normalizePolicy(Object.assign({}, this._defaultPolicy, opts.policy));
    // dependsOn: ['key:1'] (mixed plain strings = keys) or { keys: [...], tags: [...] }
    let depKeys = new Set();
    let depTags = new Set();
    if (Array.isArray(opts.dependsOn)) {
      depKeys = asSet(opts.dependsOn);
    } else if (opts.dependsOn && typeof opts.dependsOn === 'object') {
      depKeys = asSet(opts.dependsOn.keys);
      depTags = asSet(opts.dependsOn.tags);
    }
    const storedAt = now();
    const entry = {
      key,
      value,
      policy,
      tags: asSet(opts.tags),
      depKeys,
      depTags,
      storedAt,
      staleAt: policy.ttl > 0 ? storedAt + policy.ttl : Infinity,
      expiresAt: policy.swr > 0 ? storedAt + policy.ttl + policy.swr : storedAt + policy.ttl,
      staleIfErrorUntil: policy.staleIfError > 0 ? storedAt + policy.ttl + policy.staleIfError : 0,
      hits: 0,
    };
    // replace any previous entry (and its tag index)
    this._deleteInternal(key, { keepQuiet: true });
    this._stats.sets++;

    this._entries.set(key, entry);
    this._indexTags(entry);
    this._indexDeps(entry);
    this._touch(key);
    this._evictIfNeeded();
    if (this._storage && policy.persist) {
      this._storage.set(this._storageKey(key), this._serialize(this._toJSON(entry)));
    }
    this._bus.emit(KEY_PREFIX + key, { type: 'set', key, value, entry: this._meta(entry) });
    return this;
  }

  /**
   * Get a value. Stale-but-usable values (inside the swr window) are returned
   * with a background revalidation only through fetch(); plain get() is pure.
   * @returns {*} value or undefined
   */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    this._touch(key);
    if (this._isLive(entry)) {
      entry.hits++;
      return entry.value;
    }
    return undefined;
  }

  /** Get a value even if stale (no expiry check). */
  peek(key) {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    this._touch(key);
    return entry.value;
  }

  /** Full state of an entry: freshness, age, tags, dependencies. */
  meta(key) {
    const entry = this._entries.get(key);
    return entry ? this._meta(entry) : null;
  }

  has(key) {
    const entry = this._entries.get(key);
    return !!entry && this._isLive(entry);
  }

  keys() {
    return Array.from(this._entries.keys());
  }

  entries() {
    return this.keys().map((key) => this.meta(key));
  }

  size() {
    return this._entries.size;
  }

  delete(key) {
    return this._deleteInternal(key);
  }

  clear() {
    const keys = this.keys();
    for (const k of keys) this._deleteInternal(k);
    return keys;
  }

  /* ------------------------------------------------------------------ *
   * Fetcher mode (miss / stale-while-revalidate / dedupe)
   * ------------------------------------------------------------------ */

  /**
   * Get a value through a fetcher. On miss — awaits the fetcher. On stale
   * (ttl expired, still inside swr) — returns the stale value immediately and
   * revalidates in the background. Identical concurrent calls share one
   * in-flight promise.
   * @param {string} key
   * @param {(key: string) => Promise<*>} fetcher
   * @param {object} [opts] same as set()
   * @returns {Promise<*>}
   */
  async fetch(key, fetcher, opts = {}) {
    const entry = this._entries.get(key);
    if (entry && this._isLive(entry)) {
      if (now() < entry.staleAt) {
        entry.hits++;
        this._touch(key);
        this._stats.hits++;
        return entry.value;
      }
      // stale but reusable: serve and revalidate in background
      entry.hits++;
      this._touch(key);
      this._stats.hits++;
      this._revalidate(key, fetcher, opts, true);
      return entry.value;
    }
    return this._revalidate(key, fetcher, opts, false);
  }

  _revalidate(key, fetcher, opts, background) {
    if (this._inFlight.has(key)) return this._inFlight.get(key);
    const startedAt = perf();
    const generation = this._generations.get(key) || 0;
    this._stats.network++;
    // a foreground read waits for the network and counts as a miss;
    // a background SWR revalidation was already served as a hit
    const done = () => {
      if (background) return;
      this._stats.misses++;
      this._stats.missMs += perf() - startedAt;
    };
    const p = Promise.resolve()
      .then(() => fetcher(key))
      .then(
        (value) => {
          this._inFlight.delete(key);
          done();
          // the key was invalidated while the fetcher was running —
          // the result is obsolete, must not resurrect the entry
          if ((this._generations.get(key) || 0) !== generation) return value;
          this.set(key, value, opts);
          this._bus.emit(KEY_PREFIX + key, { type: 'refresh', key, value });
          return value;
        },
        (err) => {
          this._inFlight.delete(key);
          const entry = this._entries.get(key);
          if (entry && entry.staleIfErrorUntil > now()) {
            done(); // the read was served, but it did wait for a failed network call
            // keep serving stale data after a failed revalidation
            this._bus.emit(KEY_PREFIX + key, { type: 'stale-error', key, error: err });
            return entry.value;
          }
          throw err;
        }
      );
    this._inFlight.set(key, p);
    return p;
  }

  /**
   * Built-in instrumentation: counters and average latencies for fetch()
   * hits (served from cache, including stale-while-revalidate) vs misses
   * (awaited the fetcher), plus invalidation/eviction counters.
   */
  stats() {
    const s = this._stats;
    const reads = s.hits + s.misses;
    return {
      hits: s.hits,
      misses: s.misses,
      network: s.network,
      sets: s.sets,
      invalidations: s.invalidations,
      invalidatedKeys: s.invalidatedKeys,
      evictions: s.evictions,
      hitRate: reads ? s.hits / reads : null,
      avgHitLatency: s.hits ? s.hitMs / s.hits : null,
      avgMissLatency: s.misses ? s.missMs / s.misses : null,
    };
  }

  /** Zero all counters (cache entries are not affected). */
  resetStats() {
    this._stats = {
      hits: 0, hitMs: 0, misses: 0, missMs: 0, network: 0, sets: 0,
      invalidations: 0, invalidatedKeys: 0, evictions: 0,
    };
    return this;
  }

  /* ------------------------------------------------------------------ *
   * Invalidation: keys, tags, cascade over dependencies
   * ------------------------------------------------------------------ */

  /**
   * Invalidate by key(s), tag(s) or both. Cascades to entries that depend on
   * the invalidated keys/tags. Returns the list of invalidated keys.
   * @param {string|string[]|{keys?: string[], tags?: string[]}} target
   * @param {object} [opts] { cascade: boolean = true }
   */
  invalidate(target, opts = {}) {
    const cascade = opts.cascade !== false;
    let keys = new Set();
    let tags = new Set();

    if (typeof target === 'string') keys.add(target);
    else if (Array.isArray(target)) target.forEach((k) => keys.add(k));
    else if (target && typeof target === 'object') {
      (target.keys || []).forEach((k) => keys.add(k));
      (target.tags || []).forEach((t) => tags.add(t));
    }

    // initial wave: direct hits
    const direct = new Set();
    for (const k of keys) if (this._entries.has(k)) direct.add(k);
    for (const tag of tags) {
      const indexed = this._tagIndex.get(tag);
      if (indexed) for (const k of indexed) direct.add(k);
    }

    const all = cascade ? this._cascade(direct, tags) : direct;
    for (const k of all) this._deleteInternal(k, { keepQuiet: true });
    this._stats.invalidations++;
    this._stats.invalidatedKeys += all.size;

    const payload = { keys: Array.from(all), tags: Array.from(tags), reason: opts.reason || 'manual' };
    this._bus.emit('invalidate', payload);
    for (const k of all) this._bus.emit(KEY_PREFIX + k, { type: 'invalidate', key: k });
    for (const t of tags) this._bus.emit(TAG_PREFIX + t, payload);
    return payload.keys;
  }

  /** Collect all keys transitively depending on `from` keys / `fromTags`.
   *  Uses reverse dependency indexes — O(reachable keys), not O(all entries). */
  _cascade(from, fromTags) {
    const seen = new Set(from);
    const queue = Array.from(from);
    const tagQueue = Array.from(fromTags);
    while (queue.length || tagQueue.length) {
      if (queue.length) {
        for (const dep of this._depsByKey.get(queue.shift()) || []) {
          if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
        }
      }
      if (tagQueue.length) {
        for (const dep of this._depsByTag.get(tagQueue.shift()) || []) {
          if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
        }
      }
    }
    return seen;
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  /**
   * Bind an application event to an invalidation rule. Afterwards
   * emit('user:updated') invalidates the configured keys/tags.
   * The rule may carry a resolve(payload) function that computes the
   * keys/tags from the event payload at emit time — so an event can
   * invalidate exactly what changed instead of a whole tag.
   */
  bindEvent(name, rule) {
    if (!this._eventBindings.has(name)) this._eventBindings.set(name, []);
    this._eventBindings.get(name).push({
      keys: (rule && rule.keys) || [],
      tags: (rule && rule.tags) || [],
      resolve: rule && typeof rule.resolve === 'function' ? rule.resolve : null,
      cascade: !rule || rule.cascade !== false,
    });
    return this;
  }

  unbindEvent(name) {
    this._eventBindings.delete(name);
    return this;
  }

  /** Emit an application event; runs bound invalidation rules, then notifies subscribers. */
  emit(name, payload) {
    const rules = this._eventBindings.get(name) || [];
    const invalidated = [];
    for (const rule of rules) {
      const target = rule.resolve ? rule.resolve(payload) : { keys: rule.keys, tags: rule.tags };
      const hit = this.invalidate(
        { keys: (target && target.keys) || [], tags: (target && target.tags) || [] },
        { cascade: rule.cascade, reason: 'event:' + name }
      );
      invalidated.push(...hit);
    }
    const msg = { type: 'event', name, payload, invalidated: Array.from(new Set(invalidated)) };
    this._events.emit(name, msg);
    this._bus.emit(EV_PREFIX + name, msg);
    return msg.invalidated;
  }

  /* ------------------------------------------------------------------ *
   * Subscribers
   * ------------------------------------------------------------------ */

  /**
   * Subscribe to changes.
   *   on('key:user:1', cb)  — everything about a key (set/refresh/invalidate)
   *   on('tag:users', cb)   — invalidation of a tag
   *   on('event:ordered', cb) — application events
   *   on('invalidate', cb)  — global invalidation stream
   * Or pass a target object: on({ keys: [...], tags: [...] }, cb).
   * Returns an unsubscribe function; off() with the same target works too.
   */
  on(target, handler) {
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      const unsubs = [];
      for (const k of target.keys || []) unsubs.push(this.on(KEY_PREFIX + k, handler));
      for (const t of target.tags || []) unsubs.push(this.on(TAG_PREFIX + t, handler));
      for (const e of target.events || []) unsubs.push(this.on(EV_PREFIX + e, handler));
      const id = this._objectTargetId(target);
      if (!this._objectSubs.has(id)) this._objectSubs.set(id, new Map());
      this._objectSubs.get(id).set(handler, unsubs);
      return () => {
        this.off(target, handler);
      };
    }
    return this._bus.on(target, handler);
  }

  off(target, handler) {
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      const id = this._objectTargetId(target);
      const map = this._objectSubs.get(id);
      const unsubs = map && map.get(handler);
      if (unsubs) {
        unsubs.forEach((u) => u());
        map.delete(handler);
        if (!map.size) this._objectSubs.delete(id);
      }
      return;
    }
    this._bus.off(target, handler);
  }

  _objectTargetId(target) {
    return (
      'keys:' + (target.keys || []).join(',') +
      '|tags:' + (target.tags || []).join(',') +
      '|events:' + (target.events || []).join(',')
    );
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  _isLive(entry) {
    const t = now();
    return t <= entry.expiresAt || t <= entry.staleIfErrorUntil;
  }

  _touch(key) {
    // LRU: re-insert to move to the end of the Map's insertion order
    const entry = this._entries.get(key);
    if (entry) {
      this._entries.delete(key);
      this._entries.set(key, entry);
    }
  }

  _evictIfNeeded() {
    while (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next().value;
      const meta = this._meta(this._entries.get(oldest));
      this._deleteInternal(oldest);
      this._stats.evictions++;
      this._bus.emit('evict', { key: oldest, entry: meta });
    }
  }

  _indexTags(entry) {
    for (const tag of entry.tags) {
      if (!this._tagIndex.has(tag)) this._tagIndex.set(tag, new Set());
      this._tagIndex.get(tag).add(entry.key);
    }
  }

  _indexDeps(entry) {
    for (const dep of entry.depKeys) {
      if (!this._depsByKey.has(dep)) this._depsByKey.set(dep, new Set());
      this._depsByKey.get(dep).add(entry.key);
    }
    for (const dep of entry.depTags) {
      if (!this._depsByTag.has(dep)) this._depsByTag.set(dep, new Set());
      this._depsByTag.get(dep).add(entry.key);
    }
  }

  _unindexDeps(entry) {
    for (const dep of entry.depKeys) this._dropIndex(this._depsByKey, dep, entry.key);
    for (const dep of entry.depTags) this._dropIndex(this._depsByTag, dep, entry.key);
  }

  _dropIndex(index, dep, key) {
    const set = index.get(dep);
    if (set) {
      set.delete(key);
      if (!set.size) index.delete(dep);
    }
  }

  _unindexTags(entry) {
    for (const tag of entry.tags) {
      const set = this._tagIndex.get(tag);
      if (set) {
        set.delete(entry.key);
        if (!set.size) this._tagIndex.delete(tag);
      }
    }
  }

  _deleteInternal(key, { keepQuiet } = {}) {
    const entry = this._entries.get(key);
    if (entry) {
      this._entries.delete(key);
      this._unindexTags(entry);
      this._unindexDeps(entry);
    }
    // bump generation even if absent: an in-flight revalidate for this key
    // must discard its result no matter what
    this._generations.set(key, (this._generations.get(key) || 0) + 1);
    if (this._storage) this._storage.del(this._storageKey(key));
    if (!keepQuiet && entry) this._bus.emit(KEY_PREFIX + key, { type: 'delete', key });
    return !!entry;
  }

  _storageKey(key) {
    return this._namespace + ':' + key;
  }

  _meta(entry) {
    return {
      key: entry.key,
      tags: Array.from(entry.tags),
      dependsOn: { keys: Array.from(entry.depKeys), tags: Array.from(entry.depTags) },
      policy: Object.assign({}, entry.policy),
      storedAt: entry.storedAt,
      age: now() - entry.storedAt,
      stale: now() > entry.staleAt,
      expiresAt: entry.expiresAt,
      hits: entry.hits,
    };
  }

  _toJSON(entry) {
    return {
      v: 1,
      key: entry.key,
      value: entry.value,
      policy: entry.policy,
      tags: Array.from(entry.tags),
      dependsOn: { keys: Array.from(entry.depKeys), tags: Array.from(entry.depTags) },
      storedAt: entry.storedAt,
      hits: entry.hits,
    };
  }

  _hydrate() {
    const prefix = this._namespace + ':';
    for (const sk of this._storage.keys()) {
      if (!sk.startsWith || !sk.startsWith(prefix)) continue;
      let record;
      try {
        record = this._deserialize(this._storage.get(sk));
      } catch {
        this._storage.del(sk);
        continue;
      }
      if (!record || record.v !== 1) continue;
      const policy = normalizePolicy(record.policy);
      const storedAt = record.storedAt;
      const entry = {
        key: record.key,
        value: record.value,
        policy,
        tags: asSet(record.tags),
        depKeys: asSet(record.dependsOn && record.dependsOn.keys),
        depTags: asSet(record.dependsOn && record.dependsOn.tags),
        storedAt,
        staleAt: policy.ttl > 0 ? storedAt + policy.ttl : Infinity,
        expiresAt:
          policy.swr > 0 ? storedAt + policy.ttl + policy.swr : storedAt + policy.ttl,
        staleIfErrorUntil:
          policy.staleIfError > 0 ? storedAt + policy.ttl + policy.staleIfError : 0,
        hits: record.hits || 0,
      };
      // don't resurrect entries that already fully expired
      if (now() > entry.expiresAt && now() > entry.staleIfErrorUntil) {
        this._storage.del(sk);
        continue;
      }
      this._entries.set(entry.key, entry);
      this._indexTags(entry);
      this._indexDeps(entry);
    }
    this._evictIfNeeded();
  }
}

/** Factory — the main entry point. */
function createFreshl(options) {
  return new Freshl(options);
}

;

  return { createFreshl, Freshl, MemoryStorage, LocalStorageAdapter };
});
