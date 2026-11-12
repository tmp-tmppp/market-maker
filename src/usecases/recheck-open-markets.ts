import { TradingContractViolation, TradingUnavailable } from "./errors.js";
import type { CallContext, Logger, OpenMarketsPage, QuotingSettingsSource, TradingClient } from "./ports.js";
import { LIST_PAGE_SIZE } from "./support.js";
import type { QuoteMarketUseCase, QuoteOutcome, RecheckInput, RecheckOpenMarketsUseCase, RecheckSummary } from "./use-cases.js";

export interface RecheckDeps {
  trading: TradingClient;
  settings: QuotingSettingsSource;
  quote: QuoteMarketUseCase;
  logger: Logger;
}

/** The list positions one pass quotes: from `from` (earlier ones are skipped) up to, not including, `to`. */
interface Range {
  from: number;
  to: number;
}

/** What one run keeps while it goes through the pages. */
interface Run {
  input: RecheckInput;
  context: CallContext;
  summary: RecheckSummary;
  /** The position after the last market this run reached (that market's own position when it was never tried); becomes `resumeAt` when trading ends the run. */
  nextResume: number;
}

const emptySummary = (): RecheckSummary => ({
  disabled: false,
  completed: true,
  markets: 0,
  quoted: 0,
  unchanged: 0,
  stopped: 0,
  notReady: 0,
  notFound: 0,
  contended: 0,
  refused: 0,
  failed: 0,
  failure: null,
});

const describeError = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : "a value that is not an Error was thrown");

/**
 * The periodic check of the open markets (ADR-041; the start-up check is its first run): lists every open market of every
 * tenant page by page and runs a quote run for each, one after the other. The notifications cover the markets that
 * change; this covers what they miss (a missed or given-up event, a market that opened before the bot started, offers
 * that sit on an older sequence, changed settings), so a market is never unquoted for longer than the check interval.
 *
 * One market that fails must not keep the markets after it from being checked: a run that throws TradingUnavailable for
 * the call or TradingContractViolation is counted and passed over. The run ends early only when no later call can
 * succeed (the list call failed, or trading is unavailable as a service: open circuit, no token, 401, 403) or on
 * shutdown. A run that ended because of trading starts the next one at the market after it, or at that market itself when
 * its call never reached trading (`TradingUnavailable.sent === false`: the circuit was already open or there was no
 * token), so a market that was never tried is not passed over (`resumeAt`, a position in the list order, kept in memory
 * only), and wraps around to the first page, so the markets in front of the failure are checked too; positions shift
 * when markets open or close between runs, so the rotation is best effort and a market quoted twice costs one read.
 */
export class RecheckOpenMarkets implements RecheckOpenMarketsUseCase {
  /** The list position (0-based, over all pages from the first) where the next run starts quoting; 0 after a completed run. */
  private resumeAt = 0;

  constructor(private readonly deps: RecheckDeps) {}

  async execute(input: RecheckInput): Promise<RecheckSummary> {
    const summary = emptySummary();
    if (!this.deps.settings.current().enabled) return { ...summary, disabled: true };

    const start = this.resumeAt;
    const run: Run = { input, context: { correlationId: input.correlationId }, summary, nextResume: start };
    // Positions from `start` to the end first, then the ones in front of it (when there is something in front).
    const ranges: Range[] = start === 0 ? [{ from: 0, to: Infinity }] : [{ from: start, to: Infinity }, { from: 0, to: start }];
    for (const range of ranges) {
      if ((await this.pass(run, range)) === "ended") return summary;
    }
    this.resumeAt = 0;
    return summary;
  }

  /** One walk through the list from the first page; returns "ended" when the run stopped before the end of its range. */
  private async pass(run: Run, range: Range): Promise<"done" | "ended"> {
    const { trading, quote, logger } = this.deps;
    const { summary } = run;
    let cursor: string | null = null;
    let position = 0;
    for (;;) {
      if (run.input.shouldStop?.() === true) return this.stopped(run);
      let page: OpenMarketsPage;
      try {
        page = await trading.listOpenMarkets({ cursor, limit: LIST_PAGE_SIZE }, run.context);
      } catch (error) {
        return this.endedByTrading(run, error);
      }

      for (const item of page.items) {
        const current = position;
        position += 1;
        if (current < range.from) continue;
        if (run.input.shouldStop?.() === true) return this.stopped(run);

        run.nextResume = current + 1;
        let outcome: QuoteOutcome | null = null;
        try {
          outcome = await quote.execute({ marketId: item.marketId, trigger: "recheck", tenantId: item.tenantId, knownSequence: item.tradeSequence, correlationId: run.input.correlationId });
        } catch (error) {
          if (error instanceof TradingUnavailable && error.scope === "service") {
            // The circuit was already open, or there was no token, before any request for this market went out: the
            // market was never tried, so the next run starts with it instead of after it (otherwise a market behind a
            // failing one is passed over each time the failing one opens the circuit).
            if (error.sent === false) run.nextResume = current;
            return this.endedByTrading(run, error);
          }
          if (!(error instanceof TradingUnavailable) && !(error instanceof TradingContractViolation)) throw error;
          summary.failed += 1;
          summary.markets += 1;
          const fields = { marketId: item.marketId, tenantId: item.tenantId, correlationId: run.input.correlationId, errorName: error.name, errorMessage: error.message };
          if (error instanceof TradingContractViolation) logger.error(fields, "Recheck of one market failed: trading answered outside its contract");
          else logger.warn(fields, "Recheck of one market failed: trading is unavailable for the call");
        }

        if (outcome?.kind === "disabled") {
          // The kill switch was turned on while the run was going: no call may follow, so no further page is listed.
          summary.disabled = true;
          this.resumeAt = 0;
          return "ended";
        }
        if (outcome !== null) this.count(summary, outcome);
        // The pass in front of the resume position stops listing as soon as it reaches that position.
        if (position >= range.to) return "done";
      }
      if (page.nextCursor === null) return "done";
      cursor = page.nextCursor;
    }
  }

  private count(summary: RecheckSummary, outcome: Exclude<QuoteOutcome, { kind: "disabled" }>): void {
    summary.markets += 1;
    switch (outcome.kind) {
      case "quoted":
        summary.quoted += 1;
        break;
      case "unchanged":
        summary.unchanged += 1;
        break;
      case "stopped":
        summary.stopped += 1;
        break;
      case "not_ready":
        summary.notReady += 1;
        break;
      case "not_found":
        summary.notFound += 1;
        break;
      case "contended":
        summary.contended += 1;
        break;
      case "refused":
        summary.refused += 1;
        break;
    }
  }

  /** Shutdown: the position is not kept (the process ends), the summary says why the run is short. */
  private stopped(run: Run): "ended" {
    run.summary.completed = false;
    run.summary.failure = "stopped";
    return "ended";
  }

  /** The list call failed or trading is unavailable as a service: the next run goes on after the market reached last. */
  private endedByTrading(run: Run, error: unknown): "ended" {
    run.summary.completed = false;
    run.summary.failure = describeError(error);
    this.resumeAt = run.nextResume;
    this.deps.logger.warn({ correlationId: run.input.correlationId, failure: run.summary.failure, resumeAt: this.resumeAt }, "Recheck ended early");
    return "ended";
  }
}
