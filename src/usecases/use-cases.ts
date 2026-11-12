import type { MarketNotice } from "../domain/consumed.js";

// The use-case interfaces of the market maker. The classes live next to this file (quote-market.ts,
// react-to-market-event.ts, recheck-open-markets.ts); the adapters (the NATS consumers, the recheck scheduler) depend on
// these interfaces only.

/** What started a quote run (logged with every outcome). */
export type QuoteTrigger = "market_opened" | "trade_executed" | "recheck";

export interface QuoteMarketInput {
  marketId: string;
  trigger: QuoteTrigger;
  /** The tenant of the event or of the open-markets list; logged, and a book of another tenant is logged as a warning. */
  tenantId: string | null;
  /** TradeExecuted's trade sequence or the list's; logged only (the run prices on the sequence of the book it reads). */
  knownSequence: number | null;
  correlationId: string;
}

export type StopReason = "closed" | "resolved" | "past_close_time" | "market_not_open";

/**
 * The end of one quote run of one market. The consumer acknowledges the event for every outcome except "not_ready" (a
 * later delivery may succeed: `wantsRedelivery` in support.ts); a thrown TradingUnavailable or TradingContractViolation
 * is a nak.
 */
export type QuoteOutcome =
  /** One PUT replaced the offers, priced on `tradeSequence`; `attempts` counts the PUTs (stale_sequence retries + 1). */
  | { kind: "quoted"; tradeSequence: number; offers: number; attempts: number }
  /** The resting offers already equal the computed ones and are priced on the current sequence: no PUT. */
  | { kind: "unchanged"; tradeSequence: number }
  /** The market is closed, resolved or past its close time (from the book, or trading's 409 market_not_open). */
  | { kind: "stopped"; reason: StopReason }
  /** Funded but without a starting price yet (trading has not processed MarketOpened), or open without funding. */
  | { kind: "not_ready"; reason: "no_starting_price" | "not_funded" }
  /** trading knows no such market (404 on the read or the PUT). */
  | { kind: "not_found" }
  /** QUOTING_ENABLED is false: no call was made. */
  | { kind: "disabled" }
  /**
   * Every attempt met 409 stale_sequence (trades kept arriving): STALE_RETRY_ATTEMPTS were made. Acknowledged: each of
   * those trades publishes its own TradeExecuted, and the periodic check covers the rest.
   */
  | { kind: "contended"; attempts: number }
  /** trading refused the list (400, 409 insufficient_holdings), or the bot's own check of the list failed (status 0). */
  | { kind: "refused"; status: number; code: string | null; detail: string };

export interface QuoteMarketUseCase {
  /**
   * Reads the book, computes the offers and replaces them in one PUT with the book's trade sequence, re-reading on
   * 409 stale_sequence (bounded, with jitter). Runs of one market never overlap inside the process (KeyedSerializer):
   * a call that arrives while a run of the same market waits shares that waiting run and its outcome.
   */
  execute(input: QuoteMarketInput): Promise<QuoteOutcome>;
}

/**
 * What the consumer did with one event: a quote run; nothing for a closing event; or nothing for an event older than
 * the process start (`predatesStart` in support.ts: the start-up check already read that market's book after it).
 */
export type EventOutcome =
  | QuoteOutcome
  | { kind: "stop_notice"; event: "market_closed" | "market_resolved" }
  | { kind: "skipped"; reason: "before_start" };

export interface ReactToMarketEventUseCase {
  /**
   * MarketOpened and TradeExecuted: a quote run of the market (trigger from the kind), unless the event predates the
   * process start ("skipped", acknowledged without a call). MarketClosed and MarketResolved: nothing to call (trading
   * cancels the offers itself); "stop_notice" is logged and the event acknowledged.
   */
  execute(notice: MarketNotice): Promise<EventOutcome>;
}

export interface RecheckInput {
  correlationId: string;
  /** Polled between markets: true ends the run early (shutdown). */
  shouldStop?: () => boolean;
}

/** The counts of one periodic check (logged at info, at warn when `failed` or `refused` is above 0). */
export interface RecheckSummary {
  /** True when QUOTING_ENABLED was false: nothing was listed or quoted. */
  disabled: boolean;
  /** False when the run ended early: the list call failed, trading is unavailable as a service, or shouldStop(). */
  completed: boolean;
  markets: number;
  quoted: number;
  unchanged: number;
  stopped: number;
  notReady: number;
  notFound: number;
  contended: number;
  refused: number;
  /** Markets whose run threw TradingUnavailable (scope "call") or TradingContractViolation; the run went on. */
  failed: number;
  /** The reason the run ended early, or null. */
  failure: string | null;
}

export interface RecheckOpenMarketsUseCase {
  /**
   * Lists every open market of every tenant page by page (LIST_PAGE_SIZE) and runs QuoteMarket for each, one after the
   * other (trigger "recheck"), so a market whose offers are missing or priced on an older sequence is quoted again. A
   * market whose run throws TradingUnavailable (scope "call") or TradingContractViolation is logged, counted in
   * `failed` and passed over. The run ends early (completed false, failure set) when a list call fails, a run throws
   * TradingUnavailable with scope "service", or shouldStop() is true. A run that ended early because of trading makes
   * the next run start at the market after the one it stopped at and wrap around to the first page (position in the
   * list order), so no market, however often it fails, keeps the markets after it from being checked.
   */
  execute(input: RecheckInput): Promise<RecheckSummary>;
}
