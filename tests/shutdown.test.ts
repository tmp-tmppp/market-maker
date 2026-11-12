import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS, createShutdown, registerShutdownSignals } from "../src/shutdown.js";
import type { ShutdownSteps } from "../src/shutdown.js";
import { RecordingLogger } from "./support/fakes.js";

function recordingSteps(overrides: Partial<ShutdownSteps> = {}) {
  const calls: string[] = [];
  const step = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  const steps: ShutdownSteps = {
    drain: () => {
      calls.push("drain");
    },
    stopConsumers: step("stopConsumers"),
    stopRecheck: step("stopRecheck"),
    stopRuntimeConfig: step("stopRuntimeConfig"),
    closeServer: step("closeServer"),
    ...overrides,
  };
  return { calls, steps };
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains first, waits the delay, then stops everything in order and exits with 0", async () => {
    const { calls, steps } = recordingSteps();
    const exit = vi.fn();
    const shutdown = createShutdown(steps, { logger: new RecordingLogger(), delayMs: 1000, exit });
    const done = shutdown("SIGTERM");
    expect(calls).toEqual(["drain"]);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(calls).toEqual(["drain", "stopConsumers", "stopRecheck", "stopRuntimeConfig", "closeServer"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal", async () => {
    const { calls, steps } = recordingSteps();
    const exit = vi.fn();
    const shutdown = createShutdown(steps, { logger: new RecordingLogger(), delayMs: 0, exit });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(calls.filter((call) => call === "drain")).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits with 1 when a step fails, without the steps after it", async () => {
    const { calls, steps } = recordingSteps({ stopRecheck: () => Promise.reject(new Error("stuck")) });
    const exit = vi.fn();
    await createShutdown(steps, { logger: new RecordingLogger(), delayMs: 0, exit })("SIGTERM");
    expect(calls).toEqual(["drain", "stopConsumers"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when the steps take longer than the timeout", async () => {
    const { steps } = recordingSteps({ stopConsumers: () => new Promise<void>(() => undefined) });
    const exit = vi.fn();
    void createShutdown(steps, { logger: new RecordingLogger(), delayMs: 0, exit })("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("registerShutdownSignals", () => {
  it("runs the shutdown on SIGTERM and SIGINT and keeps listening", () => {
    const target = new EventEmitter();
    const shutdown = vi.fn(() => Promise.resolve());
    registerShutdownSignals(shutdown, target);
    target.emit("SIGTERM");
    target.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    expect(shutdown).toHaveBeenCalledWith("SIGINT");
    expect(target.listenerCount("SIGTERM")).toBe(1);
  });
});
