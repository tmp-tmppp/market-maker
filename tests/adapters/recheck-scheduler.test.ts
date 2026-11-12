import { afterEach, describe, expect, it, vi } from "vitest";
import { RecheckScheduler } from "../../src/adapters/recheck-scheduler.js";
import type { QuotingSettings } from "../../src/usecases/ports.js";
import type { RecheckInput, RecheckOpenMarketsUseCase, RecheckSummary } from "../../src/usecases/use-cases.js";
import { RecordingLogger, TestSettings } from "../support/fakes.js";

const summaryOf = (overrides: Partial<RecheckSummary> = {}): RecheckSummary => ({
  disabled: false,
  completed: true,
  markets: 3,
  quoted: 2,
  unchanged: 1,
  stopped: 0,
  notReady: 0,
  notFound: 0,
  contended: 0,
  refused: 0,
  failed: 0,
  failure: null,
  ...overrides,
});

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** A check the test controls: every run waits for `finish` / `fail`, or ends at once when no gate is wanted. */
class FakeRecheck implements RecheckOpenMarketsUseCase {
  readonly inputs: RecheckInput[] = [];
  private readonly gates: Array<Deferred<RecheckSummary>> = [];
  /** When false a run ends at once with `immediate`. */
  gated = true;
  immediate: RecheckSummary | Error = summaryOf();

  execute(input: RecheckInput): Promise<RecheckSummary> {
    this.inputs.push(input);
    if (!this.gated) return this.immediate instanceof Error ? Promise.reject(this.immediate) : Promise.resolve(this.immediate);
    const gate = new Deferred<RecheckSummary>();
    this.gates.push(gate);
    return gate.promise;
  }
  get runs(): number {
    return this.inputs.length;
  }
  finish(summary: RecheckSummary = summaryOf()): void {
    this.gates.shift()?.resolve(summary);
  }
  fail(error: Error): void {
    this.gates.shift()?.reject(error);
  }
}

/** Timers the test fires by hand: it records every wait and which handles were cleared. */
class ManualTimers {
  readonly waits: number[] = [];
  readonly cleared: number[] = [];
  private readonly pending = new Map<number, () => void>();
  private next = 1;
  readonly setTimer = (fn: () => void, ms: number): number => {
    const handle = this.next;
    this.next += 1;
    this.waits.push(ms);
    this.pending.set(handle, fn);
    return handle;
  };
  readonly clearTimer = (handle: unknown): void => {
    this.cleared.push(handle as number);
    this.pending.delete(handle as number);
  };
  get active(): number {
    return this.pending.size;
  }
  fire(): void {
    const [handle, fn] = [...this.pending.entries()][0] ?? [];
    if (handle === undefined || fn === undefined) throw new Error("no timer is pending");
    this.pending.delete(handle);
    fn();
  }
}

/** Lets the promise chains of a run finish (a run is only a few awaits deep). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup(): { scheduler: RecheckScheduler; recheck: FakeRecheck; timers: ManualTimers; logger: RecordingLogger; settings: TestSettings; ids: string[] } {
  const recheck = new FakeRecheck();
  const timers = new ManualTimers();
  const logger = new RecordingLogger();
  const settings = new TestSettings();
  const ids: string[] = [];
  const scheduler = new RecheckScheduler({
    recheck,
    settings,
    logger,
    newCorrelationId: () => {
      const id = `check-${String(ids.length + 1)}`;
      ids.push(id);
      return id;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { scheduler, recheck, timers, logger, settings, ids };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RecheckScheduler", () => {
  it("runs at once on start, with a new correlation id, and waits only after the run ended", async () => {
    const { scheduler, recheck, timers, ids } = setup();

    scheduler.start();
    await settle();

    expect(recheck.runs).toBe(1);
    expect(recheck.inputs[0]?.correlationId).toBe("check-1");
    expect(ids).toEqual(["check-1"]);
    expect(timers.waits).toEqual([]);

    recheck.finish();
    await settle();

    expect(timers.waits).toEqual([30_000]);
    expect(timers.active).toBe(1);
    await scheduler.stop();
  });

  it("starts the next run when the timer fires, with a fresh correlation id", async () => {
    const { scheduler, recheck, timers } = setup();
    recheck.gated = false;

    scheduler.start();
    await settle();
    timers.fire();
    await settle();
    timers.fire();
    await settle();

    expect(recheck.inputs.map((input) => input.correlationId)).toEqual(["check-1", "check-2", "check-3"]);
    await scheduler.stop();
  });

  it("reads the interval from the settings after every run", async () => {
    const { scheduler, recheck, timers, settings } = setup();
    recheck.gated = false;

    scheduler.start();
    await settle();
    settings.settings = { ...settings.settings, recheckIntervalMs: 7000 } satisfies QuotingSettings;
    timers.fire();
    await settle();
    settings.settings = { ...settings.settings, recheckIntervalMs: 120_000 };
    timers.fire();
    await settle();

    expect(timers.waits).toEqual([30_000, 7000, 120_000]);
    await scheduler.stop();
  });

  it("keeps the interval when the run was a disabled one", async () => {
    const { scheduler, recheck, timers, settings } = setup();
    recheck.gated = false;
    recheck.immediate = summaryOf({ disabled: true, markets: 0, quoted: 0, unchanged: 0 });
    settings.settings = { ...settings.settings, enabled: false };

    scheduler.start();
    await settle();

    expect(timers.waits).toEqual([30_000]);
    await scheduler.stop();
  });

  it("never overlaps: a run asked for while one is in progress answers null and starts nothing", async () => {
    const { scheduler, recheck, timers } = setup();

    scheduler.start();
    await settle();
    const second = await scheduler.runNow();
    const third = await scheduler.runNow();

    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(recheck.runs).toBe(1);

    recheck.finish();
    await settle();
    expect(timers.active).toBe(1);
    await scheduler.stop();
  });

  it("a timer that fires during a run asked for by hand starts no second run and still schedules the next wait", async () => {
    const { scheduler, recheck, timers } = setup();
    recheck.gated = false;
    scheduler.start();
    await settle();
    recheck.gated = true;

    const manual = scheduler.runNow();
    await settle();
    timers.fire();
    await settle();

    expect(recheck.runs).toBe(2);
    expect(timers.active).toBe(1);

    recheck.finish(summaryOf({ quoted: 9 }));
    expect((await manual)?.quoted).toBe(9);
    await scheduler.stop();
  });

  it("runNow returns the summary of the run", async () => {
    const { scheduler, recheck } = setup();
    recheck.gated = false;
    recheck.immediate = summaryOf({ markets: 12, quoted: 4, unchanged: 8 });

    const summary = await scheduler.runNow();

    expect(summary).toMatchObject({ markets: 12, quoted: 4, unchanged: 8 });
  });

  it("starting twice starts one chain", async () => {
    const { scheduler, recheck, timers } = setup();
    recheck.gated = false;

    scheduler.start();
    scheduler.start();
    await settle();

    expect(recheck.runs).toBe(1);
    expect(timers.active).toBe(1);
    await scheduler.stop();
  });

  describe("stop", () => {
    it("waits for the run in progress, tells it to stop, and prevents the next run", async () => {
      const { scheduler, recheck, timers } = setup();
      scheduler.start();
      await settle();
      expect(recheck.inputs[0]?.shouldStop?.()).toBe(false);

      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await settle();

      expect(stopped).toBe(false);
      expect(recheck.inputs[0]?.shouldStop?.()).toBe(true);

      recheck.finish(summaryOf({ completed: false, failure: "stopped" }));
      await stopping;

      expect(stopped).toBe(true);
      expect(timers.waits).toEqual([]);
      expect(timers.active).toBe(0);
      expect(recheck.runs).toBe(1);
    });

    it("clears the timer that waits between two runs", async () => {
      const { scheduler, recheck, timers } = setup();
      recheck.gated = false;
      scheduler.start();
      await settle();
      expect(timers.active).toBe(1);

      await scheduler.stop();

      expect(timers.cleared).toEqual([1]);
      expect(timers.active).toBe(0);
    });

    it("runNow and start answer nothing after it", async () => {
      const { scheduler, recheck } = setup();
      recheck.gated = false;
      await scheduler.stop();

      scheduler.start();
      const summary = await scheduler.runNow();
      await settle();

      expect(summary).toBeNull();
      expect(recheck.runs).toBe(0);
    });

    it("still resolves when the run it waits for fails", async () => {
      const { scheduler, recheck, logger } = setup();
      scheduler.start();
      await settle();

      const stopping = scheduler.stop();
      recheck.fail(new Error("boom"));
      await stopping;

      expect(logger.messages("error")).toEqual(["The periodic check failed; the next one is scheduled"]);
    });
  });

  describe("a run that throws", () => {
    it("is logged at error with the correlation id, and the next run is still scheduled", async () => {
      const { scheduler, recheck, timers, logger } = setup();
      scheduler.start();
      await settle();

      recheck.fail(new Error("the list call exploded"));
      await settle();

      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]).toMatchObject({ level: "error", fields: { correlationId: "check-1" } });
      expect(timers.waits).toEqual([30_000]);

      timers.fire();
      await settle();
      expect(recheck.runs).toBe(2);
      recheck.finish();
      await settle();
      expect(timers.waits).toEqual([30_000, 30_000]);
      await scheduler.stop();
    });

    it("makes runNow answer null", async () => {
      const { scheduler, recheck } = setup();
      recheck.gated = false;
      recheck.immediate = new Error("nope");

      expect(await scheduler.runNow()).toBeNull();
    });
  });

  describe("the summary is logged once per run", () => {
    it("at info when nothing failed or was refused, with the counts and the correlation id", async () => {
      const { scheduler, recheck, logger } = setup();
      recheck.gated = false;
      recheck.immediate = summaryOf({ markets: 5, quoted: 1, unchanged: 4 });

      await scheduler.runNow();

      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]).toMatchObject({
        level: "info",
        message: "Periodic check of the open markets ended",
        fields: { correlationId: "check-1", markets: 5, quoted: 1, unchanged: 4, failed: 0, refused: 0, completed: true },
      });
    });

    it.each([
      ["failed", { failed: 1 }],
      ["refused", { refused: 2 }],
      ["failed and refused", { failed: 3, refused: 1 }],
    ])("at warn when %s is above 0", async (_name, counts) => {
      const { scheduler, recheck, logger } = setup();
      recheck.gated = false;
      recheck.immediate = summaryOf(counts);

      await scheduler.runNow();

      expect(logger.lines.map((line) => line.level)).toEqual(["warn"]);
    });

    it("at info for the other counts, also when the run ended early or was disabled", async () => {
      const { scheduler, recheck, logger } = setup();
      recheck.gated = false;

      recheck.immediate = summaryOf({ completed: false, failure: "stopped", stopped: 2, notReady: 1, notFound: 1, contended: 1 });
      await scheduler.runNow();
      recheck.immediate = summaryOf({ disabled: true, markets: 0, quoted: 0, unchanged: 0 });
      await scheduler.runNow();

      expect(logger.lines.map((line) => line.level)).toEqual(["info", "info"]);
    });
  });

  describe("timers", () => {
    it("are unref'd: an object handle gets unref, a plain number is left alone", async () => {
      const recheck = new FakeRecheck();
      recheck.gated = false;
      const unref = vi.fn();
      const object = { unref } as unknown as NodeJS.Timeout;
      const scheduler = new RecheckScheduler({
        recheck,
        settings: new TestSettings(),
        logger: new RecordingLogger(),
        newCorrelationId: () => "id",
        setTimer: () => object,
        clearTimer: () => undefined,
      });

      scheduler.start();
      await settle();

      expect(unref).toHaveBeenCalledTimes(1);
      await scheduler.stop();
    });

    it("default to setTimeout and clearTimeout, on the interval of the settings", async () => {
      vi.useFakeTimers();
      const recheck = new FakeRecheck();
      recheck.gated = false;
      const scheduler = new RecheckScheduler({ recheck, settings: new TestSettings(), logger: new RecordingLogger(), newCorrelationId: () => "id" });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(recheck.runs).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(recheck.runs).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(recheck.runs).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recheck.runs).toBe(3);

      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(recheck.runs).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
