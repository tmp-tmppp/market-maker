// The metrics that are specific to the market maker: what its quote runs did. They sit on the same registry as the HTTP
// metrics of src/adapters/metrics/metrics.ts and follow the same convention (prom-client 15, bounded labels).
//
//   market_maker_quote_runs_total{outcome}  (counter) one quote run of one market ended; outcome is the kind of the run's
//       outcome (quoted, unchanged, stopped, not_ready, not_found, disabled, contended, refused) or `error` when the run
//       threw (trading unavailable, an answer outside the contract, a defect)
//   market_maker_refused_puts_total  (counter) trading answered a replacement PUT with a refusal (400, or 409
//       insufficient_holdings): a defect on one side, because the bot checks its offers against the same rules first.
//       A list the bot itself refused to send (outcome `refused` with status 0) is not a refused PUT.
//
// The label has the nine values below and nothing else: no market id and no tenant id, so the cardinality never grows with
// the data.

import { Counter } from "prom-client";
import type { Registry } from "prom-client";
import type { QuoteObserver } from "../../usecases/ports.js";
import type { QuoteOutcome } from "../../usecases/use-cases.js";

export const QUOTE_RUNS_METRIC = "market_maker_quote_runs_total";
export const REFUSED_PUTS_METRIC = "market_maker_refused_puts_total";

// A Record, so that the compiler fails when QuoteOutcome gets a kind that is not listed here.
const OUTCOMES: Record<QuoteOutcome["kind"] | "error", true> = {
  quoted: true,
  unchanged: true,
  stopped: true,
  not_ready: true,
  not_found: true,
  disabled: true,
  contended: true,
  refused: true,
  error: true,
};
export const QUOTE_RUN_OUTCOMES: readonly string[] = Object.keys(OUTCOMES);

/** Registers the two counters on `registry` (every outcome at 0 from the start, so that rate() has a series to read). */
export function createQuoteMetrics(registry: Registry): QuoteObserver {
  const runs = new Counter({
    name: QUOTE_RUNS_METRIC,
    help: "Quote runs of one market by outcome: quoted, unchanged, stopped, not_ready, not_found, disabled, contended, refused or error.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  for (const outcome of QUOTE_RUN_OUTCOMES) runs.inc({ outcome }, 0);
  const refusedPuts = new Counter({
    name: REFUSED_PUTS_METRIC,
    help: "Replacement PUTs that trading refused (400, or 409 insufficient_holdings).",
    registers: [registry],
  });
  return {
    runEnded: (result) => {
      runs.inc({ outcome: result.kind });
      if (result.kind === "refused" && result.status > 0) refusedPuts.inc();
    },
  };
}
