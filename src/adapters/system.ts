import { randomUUID } from "node:crypto";
import type { Clock, Delay, Random } from "../usecases/ports.js";

// The real clock, waits and randomness behind the ports of the use cases. The tests replace all of them (TestClock,
// InstantDelay, FixedRandom), so no unit test of a use case depends on the time or on chance.

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A plain timer: it keeps the process alive, so a quote run that waits between two attempts is never cut short. */
export const systemDelay: Delay = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Only the jitter of the retry waits uses it (support.ts `staleRetryDelayMs`); no quantity is ever drawn from it. */
export const mathRandom: Random = {
  next: () => Math.random(),
};

/** The correlation id of one periodic check: sent as X-Correlation-Id with every call of the run. */
export const newCorrelationId = (): string => randomUUID();
