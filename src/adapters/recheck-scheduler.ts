import type { Logger, QuotingSettingsSource } from "../usecases/ports.js";
import type { RecheckOpenMarketsUseCase, RecheckSummary } from "../usecases/use-cases.js";

type TimerHandle = NodeJS.Timeout | number;

export interface RecheckSchedulerOptions {
  recheck: RecheckOpenMarketsUseCase;
  /** Read again after every run: a changed RECHECK_INTERVAL_MS applies from the next wait on (ADR-037). */
  settings: QuotingSettingsSource;
  logger: Logger;
  /** One id per run: sent as X-Correlation-Id with every call of it. */
  newCorrelationId: () => string;
  /** Injected by the tests; default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injected by the tests; default clearTimeout. */
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * Runs the periodic check of the open markets (EP-1, ADR-041): at once on start (the start-up check), then
 * RECHECK_INTERVAL_MS after the end of the previous run, never two at a time. The wait is a chain of timers, not an
 * interval, so a slow check never overlaps the next one and a changed interval applies from the next wait on. A run that
 * throws is logged and the next one is scheduled: one failure never ends the loop. Timers are unref'd; the HTTP server
 * keeps the process alive. stop() prevents any further run and waits for the one in progress, which ends early at its
 * next market (`shouldStop`).
 */
export class RecheckScheduler {
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private timer: TimerHandle | null = null;
  private running: Promise<RecheckSummary | null> | null = null;
  private started = false;
  private stopped = false;

  constructor(private readonly options: RecheckSchedulerOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });
  }

  /** Starts the chain: a run at once, then one every interval after the end of the previous one. Returns at once. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.cycle();
  }

  /**
   * One check now. Null while another run is in progress (runs never overlap), after stop(), and when the run threw
   * (logged); the summary otherwise. It does not move the timer of the chain.
   */
  runNow(): Promise<RecheckSummary | null> {
    if (this.stopped || this.running) return Promise.resolve(null);
    const run: Promise<RecheckSummary | null> = this.execute().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  /** No new run, the one in progress ends at its next market; resolves when it has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer();
    await this.running;
  }

  private async cycle(): Promise<void> {
    await this.runNow();
    if (!this.stopped) this.schedule();
  }

  private schedule(): void {
    this.cancelTimer();
    const handle = this.setTimer(() => {
      this.timer = null;
      void this.cycle();
    }, this.options.settings.current().recheckIntervalMs);
    // An object handle (Node's Timeout) can be unref'd; the tests may hand back a plain number.
    if (typeof handle === "object") handle.unref();
    this.timer = handle;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async execute(): Promise<RecheckSummary | null> {
    const { recheck, logger, newCorrelationId } = this.options;
    const correlationId = newCorrelationId();
    try {
      const summary = await recheck.execute({ correlationId, shouldStop: () => this.stopped });
      const level = summary.failed > 0 || summary.refused > 0 ? "warn" : "info";
      logger[level]({ correlationId, ...summary }, "Periodic check of the open markets ended");
      return summary;
    } catch (error) {
      logger.error({ correlationId, err: error }, "The periodic check failed; the next one is scheduled");
      return null;
    }
  }
}
