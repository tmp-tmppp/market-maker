import { afterEach, describe, expect, it, vi } from "vitest";
import { mathRandom, newCorrelationId, systemClock, systemDelay } from "../../src/adapters/system.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("systemClock", () => {
  it("returns the current time as a new Date each call", () => {
    const before = Date.now();
    const first = systemClock.now();
    const second = systemClock.now();

    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThanOrEqual(before);
    expect(first).not.toBe(second);
  });

  it("follows the (fake) system time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z"));

    expect(systemClock.now().toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });
});

describe("systemDelay", () => {
  it("resolves after the wait and not before", async () => {
    vi.useFakeTimers();
    let done = false;
    const waiting = systemDelay.sleep(250).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(done).toBe(true);
  });
});

describe("mathRandom", () => {
  it("returns numbers in [0, 1)", () => {
    for (let i = 0; i < 1000; i += 1) {
      const value = mathRandom.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("newCorrelationId", () => {
  it("returns a fresh UUID each call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));

    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
