import { test } from "node:test";
import assert from "node:assert/strict";

import { Throttle } from "../lib/throttle.ts";

/**
 * Deterministic virtual clock: `sleep` advances `now` instead of waiting, so
 * rate-limit timing is tested without real delays.
 */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(0, ms);
    },
    advance: (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

test("throttle: min interval enforced between consecutive calls", async () => {
  const clock = virtualClock();
  const th = new Throttle({
    maxPerWindow: 1000,
    windowMs: 60_000,
    minIntervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });

  await th.acquire();
  const t0 = clock.time;
  await th.acquire();
  assert.ok(clock.time - t0 >= 1000, `expected >=1000ms gap, got ${clock.time - t0}`);
  const t1 = clock.time;
  await th.acquire();
  assert.ok(clock.time - t1 >= 1000);
});

test("throttle: window cap forces wait until oldest expires", async () => {
  const clock = virtualClock();
  const th = new Throttle({
    maxPerWindow: 3,
    windowMs: 10_000,
    minIntervalMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });

  // 3 immediate calls fill the window.
  await th.acquire();
  await th.acquire();
  await th.acquire();
  assert.equal(clock.time, 0, "first 3 should not wait");

  // 4th must wait ~windowMs for the first to age out.
  await th.acquire();
  assert.ok(clock.time >= 10_000, `4th call should wait for window, got ${clock.time}`);
});

test("throttle: calls spread over time do not over-wait", async () => {
  const clock = virtualClock();
  const th = new Throttle({
    maxPerWindow: 2,
    windowMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });

  await th.acquire(); // t=0
  clock.advance(600);
  await th.acquire(); // t=600, still within window (2 allowed)
  assert.equal(clock.time, 600);
  clock.advance(600); // t=1200; first (t=0) now outside 1000ms window
  await th.acquire();
  assert.equal(clock.time, 1200, "no wait needed once oldest aged out");
});

test("throttle: windowCount reflects live entries", async () => {
  const clock = virtualClock();
  const th = new Throttle({
    maxPerWindow: 10,
    windowMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  await th.acquire();
  await th.acquire();
  assert.equal(th.windowCount, 2);
  clock.advance(1001);
  assert.equal(th.windowCount, 0, "entries older than window are pruned");
});

test("throttle: concurrent acquires are serialized (no burst past limit)", async () => {
  const clock = virtualClock();
  const th = new Throttle({
    maxPerWindow: 2,
    windowMs: 1000,
    minIntervalMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  const order: number[] = [];
  // Fire 5 acquisitions "at once".
  await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => {
      await th.acquire();
      order.push(i);
    }),
  );

  // All completed, in order, and never more than maxPerWindow within any window.
  assert.deepEqual(order.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test("throttle: rejects invalid options", () => {
  assert.throws(() => new Throttle({ maxPerWindow: 0, windowMs: 1000 }));
  assert.throws(() => new Throttle({ maxPerWindow: 1, windowMs: 0 }));
});
