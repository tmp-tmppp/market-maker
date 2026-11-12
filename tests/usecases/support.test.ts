import { describe, expect, it } from "vitest";
import { TradingUnavailable } from "../../src/usecases/errors.js";
import { EVENT_BEFORE_START_MARGIN_MS, KeyedSerializer, STALE_RETRY_BASE_DELAY_MS, predatesStart, staleRetryDelayMs, wantsRedelivery } from "../../src/usecases/support.js";
import { FixedRandom } from "../support/fakes.js";

/** A promise the test resolves by hand. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("KeyedSerializer", () => {
  it("never overlaps two runs of one key, and lets other keys run at once", async () => {
    const serializer = new KeyedSerializer<string>();
    const first = gate<string>();
    const log: string[] = [];
    const a1 = serializer.run("a", async () => {
      log.push("a1 start");
      return first.promise;
    });
    const a2 = serializer.run("a", () => {
      log.push("a2 start");
      return Promise.resolve("a2");
    });
    const b1 = serializer.run("b", () => {
      log.push("b1 start");
      return Promise.resolve("b1");
    });
    await flush();
    expect(log).toEqual(["a1 start", "b1 start"]);
    expect(serializer.activeKeys).toBe(1);
    first.resolve("a1");
    expect(await a1).toBe("a1");
    expect(await a2).toBe("a2");
    expect(await b1).toBe("b1");
    expect(log).toEqual(["a1 start", "b1 start", "a2 start"]);
    expect(serializer.activeKeys).toBe(0);
  });

  it("lets callers that arrive while a run waits share that waiting run", async () => {
    const serializer = new KeyedSerializer<number>();
    const first = gate<number>();
    let runs = 0;
    const work = (): Promise<number> => {
      runs += 1;
      return runs === 1 ? first.promise : Promise.resolve(runs);
    };
    const one = serializer.run("m", work);
    const two = serializer.run("m", work);
    const three = serializer.run("m", work);
    expect(two).toBe(three);
    first.resolve(1);
    expect(await one).toBe(1);
    expect(await two).toBe(2);
    expect(await three).toBe(2);
    expect(runs).toBe(2);
  });

  it("starts the waiting run after a failed one and passes the failure to its own callers only", async () => {
    const serializer = new KeyedSerializer<string>();
    const first = gate<string>();
    const failing = serializer.run("m", () => first.promise);
    const next = serializer.run("m", () => Promise.resolve("next"));
    first.reject(new Error("trading is down"));
    await expect(failing).rejects.toThrow("trading is down");
    expect(await next).toBe("next");
    const thrown = serializer.run("m", () => {
      throw new Error("sync");
    });
    await expect(thrown).rejects.toThrow("sync");
    expect(await serializer.run("m", () => Promise.resolve("after"))).toBe("after");
  });
});

describe("retry helpers", () => {
  it("waits longer with each stale attempt, with jitter around the base", () => {
    expect(staleRetryDelayMs(1, new FixedRandom(0.5))).toBe(STALE_RETRY_BASE_DELAY_MS);
    expect(staleRetryDelayMs(3, new FixedRandom(0))).toBe(STALE_RETRY_BASE_DELAY_MS * 1.5);
    expect(staleRetryDelayMs(2, new FixedRandom(0.999))).toBeLessThan(STALE_RETRY_BASE_DELAY_MS * 3);
  });

  it("asks for a redelivery only when a later one may change the outcome", () => {
    expect(wantsRedelivery({ kind: "not_ready", reason: "no_starting_price" })).toBe(true);
    // The trades behind the stale answers each publish a TradeExecuted; a nak would only hold an ack-pending place.
    expect(wantsRedelivery({ kind: "contended", attempts: 5 })).toBe(false);
    expect(wantsRedelivery({ kind: "skipped", reason: "before_start" })).toBe(false);
    expect(wantsRedelivery({ kind: "quoted", tradeSequence: 1, offers: 6, attempts: 1 })).toBe(false);
    expect(wantsRedelivery({ kind: "stopped", reason: "market_not_open" })).toBe(false);
    expect(wantsRedelivery({ kind: "stop_notice", event: "market_closed" })).toBe(false);
    expect(wantsRedelivery({ kind: "refused", status: 400, code: "crossed_offers", detail: "x" })).toBe(false);
  });

  it("skips only events older than the start by more than the margin", () => {
    const startedAt = new Date("2026-11-11T12:00:00.000Z");
    const before = (ms: number): Date => new Date(startedAt.getTime() - ms);
    expect(predatesStart(before(EVENT_BEFORE_START_MARGIN_MS + 1), startedAt)).toBe(true);
    expect(predatesStart(before(24 * 3_600_000), startedAt)).toBe(true);
    expect(predatesStart(before(EVENT_BEFORE_START_MARGIN_MS), startedAt)).toBe(false);
    expect(predatesStart(before(0), startedAt)).toBe(false);
    expect(predatesStart(before(-5000), startedAt)).toBe(false);
    expect(predatesStart(null, startedAt)).toBe(false);
  });
});

describe("TradingUnavailable", () => {
  it("defaults to the scope of one call, so a forgotten scope never ends a periodic check early", () => {
    expect(new TradingUnavailable("timeout").scope).toBe("call");
    const cause = new Error("circuit open");
    const error = new TradingUnavailable("circuit open", { scope: "service", cause });
    expect(error).toMatchObject({ scope: "service", code: "trading_unavailable", name: "TradingUnavailable", cause });
  });
});
