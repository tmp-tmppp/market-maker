import type { Logger } from "./usecases/ports.js";

/** The most that stopping the consumers, the periodic check and the server may take, counted after the drain delay. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** What a shutdown does, step by step. The composition root supplies the real ones; the tests supply fakes. */
export interface ShutdownSteps {
  /** Readiness answers 503 from now on. */
  drain(): void;
  /** Stops both consumers (MARKETS, TRADING): the message in hand is finished and settled, the rest stay on the streams. */
  stopConsumers(): Promise<void>;
  /** Stops the periodic check: no new run starts, and a run in progress ends after the market it is quoting. */
  stopRecheck(): Promise<void>;
  /** Stops watching the runtime configuration file. */
  stopRuntimeConfig(): Promise<void>;
  /** Closes the health server and then the metrics listener last, so the liveness probe and a scrape answer while the work above finishes. */
  closeServer(): Promise<void>;
}

export interface ShutdownOptions {
  logger: Logger;
  /** How long the service keeps working after readiness turned 503 (SHUTDOWN_DELAY_MS; 0 by default: no traffic is routed to the bot). */
  delayMs: number;
  /** The hard limit for the steps after the delay; when it passes, the process exits with 1. Default SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Ends the process. The real one is process.exit. */
  exit: (code: number) => void;
}

/**
 * Runs `shutdown` on SIGTERM and SIGINT. The listeners stay registered (`on`, not `once`): createShutdown ignores a
 * second signal, but with no listener left Node would end the process at once on it, before the consumers finished the
 * message in hand. The hard-exit timer of createShutdown still ends a stuck shutdown.
 */
export function registerShutdownSignals(
  shutdown: (signal: string) => Promise<void>,
  target: { on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown } = process,
): void {
  target.on("SIGTERM", () => void shutdown("SIGTERM"));
  target.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * The graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal). Readiness answers 503 at once; after
 * `delayMs` the steps run one after the other: stop the consumers (no new event starts a quote run), stop the periodic
 * check, stop the runtime watcher, close the health server. A quote run in progress finishes, so no PUT is cut off
 * half way (and a cut-off PUT would be harmless anyway: trading applies it whole or not at all). A timer started with
 * the drain ends the process with 1 when all that takes longer than `delayMs` plus `timeoutMs`; it does not keep the
 * process alive. A step that fails ends the process with 1, and the steps after it do not run. A second signal changes
 * nothing.
 */
export function createShutdown(steps: ShutdownSteps, options: ShutdownOptions): (signal: string) => Promise<void> {
  const { logger, delayMs, exit } = options;
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;
    steps.drain();
    logger.info({ signal, delayMs }, "Shutting down: the readiness probe now answers 503");
    const hardExit = setTimeout(() => {
      logger.error({}, "Shutdown took too long; exiting");
      exit(1);
    }, delayMs + timeoutMs);
    hardExit.unref();
    try {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      await steps.stopConsumers();
      await steps.stopRecheck();
      await steps.stopRuntimeConfig();
      await steps.closeServer();
      logger.info({}, "Stopped");
      clearTimeout(hardExit);
      exit(0);
    } catch (error) {
      logger.error({ err: error }, "Shutdown failed");
      clearTimeout(hardExit);
      exit(1);
    }
  };
}
