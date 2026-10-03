// Last edited: 2026-10-03 18:27 CDT
// Two small caches so every open tab shares one set of slow calls. `memo` holds a value for a few
// seconds and shares one in-flight call. `createLinearCache` keeps the last good Linear lists for
// a minute and refreshes them in the background (stale-while-refresh), with one lazily created
// client that is dropped after an error so the next refresh reconnects.

import type { LinearClient } from "../linear/index.ts";
import type { Logger } from "../log.ts";
import type { LinearSnapshot } from "./data.ts";

export interface Memo<T> {
  get(): Promise<T>;
  /** Forget the value, so the next `get` recomputes (after a kill, for instance). */
  invalidate(): void;
}

/** Cache `fn`'s result for `ttlMs`. Callers during a computation share its promise. */
export function memo<T>(ttlMs: number, now: () => Date, fn: () => Promise<T>): Memo<T> {
  let value: { at: number; result: T } | null = null;
  let inflight: Promise<T> | null = null;
  return {
    get() {
      if (value && now().getTime() - value.at < ttlMs) return Promise.resolve(value.result);
      if (!inflight) {
        inflight = fn()
          .then((result) => {
            value = { at: now().getTime(), result };
            return result;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    invalidate() {
      value = null;
    },
  };
}

export interface LinearCacheDeps {
  /** Null when no API key is set: the cache then reports why and never calls Linear. */
  connect: (() => Promise<LinearClient>) | null;
  ttlMs: number;
  now: () => Date;
  log: Logger;
}

export interface LinearCache {
  /** The lists, awaiting the first fetch only; later fetches run behind the cached copy. */
  snapshot(): Promise<LinearSnapshot>;
  /** The shared client, connecting if needed. Throws when no key is set. */
  client(): Promise<LinearClient>;
}

export const NO_LINEAR_KEY = "MARSHALL_LINEAR_API_KEY is not set";

export function createLinearCache(deps: LinearCacheDeps): LinearCache {
  let client: LinearClient | null = null;
  let state: LinearSnapshot = { pickable: null, awaitingIds: null, fetchedAt: null, error: null };
  let attemptedAt = 0;
  let inflight: Promise<void> | null = null;

  const getClient = async (): Promise<LinearClient> => {
    if (!deps.connect) throw new Error(NO_LINEAR_KEY);
    client ??= await deps.connect();
    return client;
  };

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      attemptedAt = deps.now().getTime();
      try {
        const linear = await getClient();
        const [pickable, awaiting] = await Promise.all([
          linear.listPickable(),
          linear.listAwaitingMerge(),
        ]);
        state = {
          pickable,
          awaitingIds: new Set(awaiting.map((i) => i.id)),
          fetchedAt: deps.now().toISOString(),
          error: null,
        };
      } catch (err) {
        client = null;
        state = { ...state, error: (err as Error).message };
        deps.log.warn("dashboard.linear_failed", { error: state.error });
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async snapshot() {
      if (!deps.connect) return { ...state, error: NO_LINEAR_KEY };
      // Nothing to show yet: wait for the first fetch (or join the one already running).
      if (attemptedAt === 0 || (inflight && state.pickable === null)) await refresh();
      else if (deps.now().getTime() - attemptedAt >= deps.ttlMs) void refresh();
      return state;
    },
    client: getClient,
  };
}
