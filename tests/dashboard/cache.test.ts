// Last edited: 2026-10-03 18:27 CDT
// The dashboard's caches: `memo` computes once per window and shares one in-flight call; the
// Linear cache fetches once per minute, once in flight, serves the old lists while it refreshes,
// keeps them after a failure, and reconnects after an error.

import { describe, expect, test } from "bun:test";
import { createLinearCache, memo, NO_LINEAR_KEY } from "../../src/dashboard/cache.ts";
import type { LinearClient } from "../../src/linear/index.ts";
import { recordingLogger } from "../helpers.ts";
import { pickable } from "../scheduler/fake-client.ts";

function clock(start = 0) {
  const c = { t: start, now: () => new Date(c.t) };
  return c;
}

describe("memo", () => {
  test("one call per window; concurrent callers share it; invalidate forces a new one", async () => {
    const c = clock(1_000);
    let calls = 0;
    const m = memo(4_000, c.now, async () => ++calls);
    expect(await Promise.all([m.get(), m.get()])).toEqual([1, 1]);
    c.t += 3_999;
    expect(await m.get()).toBe(1);
    c.t += 1;
    expect(await m.get()).toBe(2);
    m.invalidate();
    expect(await m.get()).toBe(3);
  });
});

/** A client whose two list calls are counted, and that fails while `fail` is set. */
function fakeLinear() {
  const state = { lists: 0, connects: 0, fail: false };
  const client = {
    listPickable: async () => {
      state.lists += 1;
      if (state.fail) throw new Error("Linear is down");
      return [pickable({ identifier: `TOD-${state.lists}` })];
    },
    listAwaitingMerge: async () => [pickable({ identifier: "TOD-50", id: "uuid-50" })],
  } as unknown as LinearClient;
  return {
    state,
    connect: async () => {
      state.connects += 1;
      return client;
    },
  };
}

describe("createLinearCache", () => {
  test("first snapshot waits; within 60 s no new call; after it, the old list serves while refreshing", async () => {
    const c = clock(1_000);
    const fake = fakeLinear();
    const cache = createLinearCache({
      connect: fake.connect,
      ttlMs: 60_000,
      now: c.now,
      log: recordingLogger().log,
    });
    const [a, b] = await Promise.all([cache.snapshot(), cache.snapshot()]);
    expect(fake.state.lists).toBe(1);
    expect(a.pickable?.[0]?.identifier).toBe("TOD-1");
    expect(b.pickable?.[0]?.identifier).toBe("TOD-1");
    expect(a.awaitingIds?.has("uuid-50")).toBe(true);
    c.t += 59_000;
    await cache.snapshot();
    expect(fake.state.lists).toBe(1);
    c.t += 1_000;
    const stale = await cache.snapshot();
    expect(stale.pickable?.[0]?.identifier).toBe("TOD-1");
    await Bun.sleep(0);
    expect((await cache.snapshot()).pickable?.[0]?.identifier).toBe("TOD-2");
    expect(fake.state.connects).toBe(1);
  });

  test("a failure keeps the last good list, records the error, and reconnects next time", async () => {
    const c = clock(1_000);
    const fake = fakeLinear();
    const { log, lines } = recordingLogger();
    const cache = createLinearCache({ connect: fake.connect, ttlMs: 60_000, now: c.now, log });
    await cache.snapshot();
    fake.state.fail = true;
    c.t += 60_000;
    await cache.snapshot();
    await Bun.sleep(0);
    const failed = await cache.snapshot();
    expect(failed.error).toBe("Linear is down");
    expect(failed.pickable?.[0]?.identifier).toBe("TOD-1");
    expect(lines.some((l) => l.event === "dashboard.linear_failed")).toBe(true);
    fake.state.fail = false;
    c.t += 60_000;
    await cache.snapshot();
    await Bun.sleep(0);
    expect((await cache.snapshot()).error).toBeNull();
    expect(fake.state.connects).toBe(2);
  });

  test("no key: never calls Linear, says why, and client() throws", async () => {
    const cache = createLinearCache({
      connect: null,
      ttlMs: 60_000,
      now: clock().now,
      log: recordingLogger().log,
    });
    expect(await cache.snapshot()).toEqual({
      pickable: null,
      awaitingIds: null,
      fetchedAt: null,
      error: NO_LINEAR_KEY,
    });
    await expect(cache.client()).rejects.toThrow(NO_LINEAR_KEY);
  });
});
