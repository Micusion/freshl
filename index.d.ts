// Type declarations for freshl
// Licensed under the Apache License, Version 2.0.

/** Caching policy. All durations in milliseconds. */
export interface FreshlPolicy {
  /** How long the value is considered fresh. Default: 5 min. */
  ttl?: number;
  /** After ttl: serve stale immediately and revalidate in the background for this long. Default: 0. */
  swr?: number;
  /** After ttl: keep serving stale if the fetcher fails, for this long (from store time). Default: 0. */
  staleIfError?: number;
  /** Whether this entry is written to the storage adapter (when one is configured). Default: true. */
  persist?: boolean;
}

/** Entry options for set() / fetch(). */
export interface FreshlEntryOptions {
  policy?: FreshlPolicy;
  /** Human-readable invalidation tags. */
  tags?: string | string[];
  /**
   * Dependencies: a plain array means "depends on these keys";
   * `{ keys: [...], tags: [...] }` means "depends on those keys and/or tags".
   * Invalidation cascades transitively through dependencies.
   */
  dependsOn?: string[] | { keys?: string[]; tags?: string[] };
}

/** Everything known about a cached entry. */
export interface FreshlMeta {
  key: string;
  tags: string[];
  dependsOn: { keys: string[]; tags: string[] };
  policy: FreshlPolicy;
  storedAt: number;
  age: number;
  stale: boolean;
  expiresAt: number;
  hits: number;
}

export interface FreshlStats {
  /** Reads served from cache (fresh, or stale via swr). */
  hits: number;
  /** Reads that had to await the fetcher. */
  misses: number;
  /** Fetcher invocations (in-flight dedupe counts once). */
  network: number;
  /** set() calls. */
  sets: number;
  invalidations: number;
  invalidatedKeys: number;
  /** LRU evictions. */
  evictions: number;
  /** hits / (hits + misses), or null before the first read. */
  hitRate: number | null;
  avgHitLatency: number | null;
  avgMissLatency: number | null;
}

/** Invalidated keys and their tags, as passed to 'invalidate' subscribers. */
export interface FreshlInvalidationPayload {
  keys: string[];
  tags: string[];
  reason: string;
}

export type FreshlKeyMessage =
  | { type: 'set'; key: string; value: unknown }
  | { type: 'refresh'; key: string; value: unknown }
  | { type: 'invalidate'; key: string }
  | { type: 'delete'; key: string }
  | { type: 'stale-error'; key: string; error: unknown };

export interface FreshlEventMessage {
  type: 'event';
  name: string;
  payload: unknown;
  invalidated: string[];
}

/** Storage adapter interface: get/set/del/keys over string values. */
export interface FreshlStorageAdapter {
  get(key: string): string | null;
  set(key: string, text: string): void;
  del(key: string): void;
  keys(): string[];
}

export interface FreshlOptions {
  defaultPolicy?: FreshlPolicy;
  /** Max entries before LRU eviction. Default: Infinity. */
  maxEntries?: number;
  /**
   * Persistence: `true` to use global localStorage, a Storage-like object,
   * or any adapter implementing { get, set, del, keys }.
   */
  storage?: boolean | Storage | FreshlStorageAdapter;
  /** Key prefix in the storage. Default: 'freshl'. */
  namespace?: string;
  serialize?: (entry: unknown) => string;
  deserialize?: (text: string) => unknown;
}

export type InvalidateTarget =
  | string
  | string[]
  | { keys?: string[]; tags?: string[] };

export type SubscribeTarget =
  | string
  | { keys?: string[]; tags?: string[]; events?: string[] };

/** Invalidation rule for bindEvent(). */
export interface EventBindingRule {
  keys?: string[];
  tags?: string[];
  /** Compute keys/tags from the emit() payload: invalidate exactly what changed. */
  resolve?: (payload: unknown) => { keys?: string[]; tags?: string[] };
  /** Cascade through dependencies. Default: true. */
  cascade?: boolean;
}

export declare class Freshl {
  constructor(options?: FreshlOptions);

  set<T = unknown>(key: string, value: T, opts?: FreshlEntryOptions): this;
  get<T = unknown>(key: string): T | undefined;
  peek<T = unknown>(key: string): T | undefined;
  has(key: string): boolean;
  meta(key: string): FreshlMeta | null;
  fetch<T = unknown>(key: string, fetcher: (key: string) => Promise<T>, opts?: FreshlEntryOptions): Promise<T>;
  invalidate(target: InvalidateTarget, opts?: { cascade?: boolean; reason?: string }): string[];
  bindEvent(name: string, rule: EventBindingRule): this;
  unbindEvent(name: string): this;
  emit(name: string, payload?: unknown): string[];
  on(target: 'invalidate' | `key:${string}` | `tag:${string}` | `event:${string}`, handler: (message: FreshlKeyMessage | FreshlInvalidationPayload) => void): () => void;
  on(target: SubscribeTarget, handler: (message: unknown) => void): () => void;
  off(target: SubscribeTarget, handler?: (message: unknown) => void): void;
  stats(): FreshlStats;
  resetStats(): this;
  keys(): string[];
  entries(): FreshlMeta[];
  size(): number;
  delete(key: string): boolean;
  clear(): string[];
}

export declare function createFreshl(options?: FreshlOptions): Freshl;

export declare class MemoryStorage implements FreshlStorageAdapter {
  constructor();
  get(key: string): string | null;
  set(key: string, text: string): void;
  del(key: string): void;
  keys(): string[];
}

export declare class LocalStorageAdapter implements FreshlStorageAdapter {
  constructor(storage?: Storage | null);
  get(key: string): string | null;
  set(key: string, text: string): void;
  del(key: string): void;
  keys(): string[];
}
