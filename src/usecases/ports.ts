import type { BotBook, BotMarket } from "../domain/book.js";
import type { Offer } from "../domain/offers.js";
import type { PricingSettings } from "../domain/pricing.js";
import type { QuoteOutcome } from "./use-cases.js";

// The ports of the market maker: what the use cases need from the outside, as interfaces. The adapters implement them
// (src/adapters), the composition root wires them (src/main.ts), and the tests replace them with fakes. The bot owns no
// data (ADR-041), so there is no repository: trading's internal API is its only source and its only sink.

/** pino's logger fits this shape. Log fields: marketId, tenantId, eventId, correlationId, trigger; never a token. */
export interface Logger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface Clock {
  now(): Date;
}

/** Waits between attempts; the tests resolve it at once and record the waits. */
export interface Delay {
  sleep(ms: number): Promise<void>;
}

/** A number in [0, 1): the jitter of the retry waits. */
export interface Random {
  next(): number;
}

/** The runtime keys of the quoting (ADR-037; config.ts): read again at every quote run and every recheck. */
export interface QuotingSettings extends PricingSettings {
  /** QUOTING_ENABLED, the kill switch: false = no call to trading at all (resting offers stay and keep filling). */
  enabled: boolean;
  /** RECHECK_INTERVAL_MS: the wait between two periodic checks of the open markets. */
  recheckIntervalMs: number;
}

export interface QuotingSettingsSource {
  current(): QuotingSettings;
}

/** Sent with every call to trading as X-Correlation-Id, so trading's logs tie the call to the event or the recheck. */
export interface CallContext {
  correlationId: string;
}

/** One page of GET /v1/internal/markets?status=open (all tenants, by tenant id then market id). */
export interface OpenMarketsPage {
  items: BotMarket[];
  nextCursor: string | null;
}

/** The body of PUT /v1/internal/markets/{marketId}/bot-orders. */
export interface ReplaceOffersRequest {
  /** The `tradeSequence` of the book the offers were priced on (never its `offersPricedOnSequence`). */
  basedOnSequence: number;
  offers: Offer[];
}

/** trading's answer to a replacement, for every status the contract defines except the failures (thrown, below). */
export type ReplaceResult =
  /** 200: the new book. */
  | { kind: "replaced"; book: BotBook }
  /** 409 stale_sequence: a trade happened since the book was read; `tradeSequence` is the current one when sent. */
  | { kind: "stale_sequence"; tradeSequence: number | null }
  /** 409 market_not_open: closed, resolved, unfunded or past its close time: stop quoting it, never retry. */
  | { kind: "market_not_open" }
  /** 404: trading knows no such market. */
  | { kind: "not_found" }
  /**
   * 400 (validation_failed, crossed_offers) or 409 insufficient_holdings: trading refused a list the bot checked
   * against the same rules, so a defect on one side; repeating the same list would change nothing.
   */
  | { kind: "refused"; status: number; code: string | null; detail: string };

/**
 * trading's internal API for the bot (contracts/outgoing/trading-bot.openapi.yaml), called with the client-credentials
 * token of the client `market-maker`. Every method throws TradingUnavailable (usecases/errors.ts) when trading cannot
 * answer now: network errors, timeouts, 408, 429, 5xx, an open circuit, no service token, or 401/403 (the token or the
 * client is refused, which an operator fixes). It throws TradingContractViolation for an answer outside the contract
 * (an unexpected status or a body that fails the schema). Only the two reads are retried inside the adapter; the PUT is
 * sent once per call (the use case reads again and decides anew).
 */
export interface TradingClient {
  listOpenMarkets(page: { cursor: string | null; limit: number }, context: CallContext): Promise<OpenMarketsPage>;
  /** Null for 404. */
  getBotBook(marketId: string, context: CallContext): Promise<BotBook | null>;
  replaceBotOrders(marketId: string, request: ReplaceOffersRequest, context: CallContext): Promise<ReplaceResult>;
}

/**
 * Told how every quote run ended, for the metrics (src/adapters/metrics/quote-metrics.ts). It only observes: whatever it
 * does or throws, the run's outcome is unchanged.
 */
export interface QuoteObserver {
  /** One run of one market ended: with its outcome, or `error` when it threw (TradingUnavailable, TradingContractViolation, a defect). */
  runEnded(result: QuoteOutcome | { kind: "error" }): void;
}

/** What QuoteMarket needs. */
export interface QuoteDeps {
  trading: TradingClient;
  settings: QuotingSettingsSource;
  clock: Clock;
  delay: Delay;
  random: Random;
  logger: Logger;
  /** Optional: the metrics. */
  observer?: QuoteObserver;
}
