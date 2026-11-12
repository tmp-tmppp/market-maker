import type { Offer } from "./offers.js";

// The bot's view of one market, as trading's internal API returns it (contracts/outgoing/trading-bot.openapi.yaml,
// GET /v1/internal/markets/{marketId}/bot-book). The market maker keeps no copy of it (ADR-041): every quote run reads
// it again, so these types describe one answer, never stored state.

export const MARKET_STATUSES = ["funded", "open", "closed", "resolved"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

/** trading's copy of a market (BotMarket of the contract). */
export interface BotMarket {
  marketId: string;
  tenantId: string;
  status: MarketStatus;
  version: number;
  /** Null until trading has processed MarketOpened. */
  closeTime: Date | null;
  /** The creator's starting YES price in microcredits per share; null until trading has processed MarketOpened. */
  startingPriceMicro: number | null;
  /** The funding in microcredits (= the pairs the bot account received); null until the funding call. */
  fundingMicro: number | null;
  tradeSequence: number;
}

/** What the market's bot account holds in trading's ledger. */
export interface Holdings {
  balanceMicro: number;
  yesMicro: number;
  noMicro: number;
}

export interface BotBook {
  market: BotMarket;
  holdings: Holdings;
  /** The resting offers, in any order. */
  offers: Offer[];
  /** The market's current trade sequence: the `basedOnSequence` of the next replacement. */
  tradeSequence: number;
  /** The sequence the resting offers were priced on; null without offers. Information only: a fill keeps it. */
  offersPricedOnSequence: number | null;
  /**
   * The most offers per side trading accepts now (its runtime MAX_OFFERS_PER_SIDE, 1..50), read with the book: a
   * replacement with more offers on one side is refused 400, so the bot quotes at most this many levels per side.
   */
  maxOffersPerSide: number;
}

/** What a quote run does with a book. */
export type QuotingState =
  | { kind: "quote"; fundingMicro: number; startingPriceMicro: number; maxOffersPerSide: number }
  | { kind: "stopped"; reason: "closed" | "resolved" | "past_close_time" }
  /**
   * The market is funded but trading has not processed MarketOpened yet (no starting price), or it is open without
   * funding: the bot cannot price it now, and a later delivery or the periodic check will.
   */
  | { kind: "not_ready"; reason: "no_starting_price" | "not_funded" };

/**
 * Decides from the book alone whether the bot quotes the market now. Closed, resolved and past-close markets are
 * stopped (trading cancels their offers itself and would answer 409 market_not_open); a funded copy is quoted as soon
 * as it carries a starting price, because trading accepts offers on a funded copy (they rest until the market opens).
 */
export function quotingStateOf(book: BotBook, now: Date): QuotingState {
  const { market } = book;
  if (market.status === "closed" || market.status === "resolved") return { kind: "stopped", reason: market.status };
  if (market.closeTime !== null && now.getTime() >= market.closeTime.getTime()) return { kind: "stopped", reason: "past_close_time" };
  if (market.fundingMicro === null) return { kind: "not_ready", reason: "not_funded" };
  if (market.startingPriceMicro === null) return { kind: "not_ready", reason: "no_starting_price" };
  return { kind: "quote", fundingMicro: market.fundingMicro, startingPriceMicro: market.startingPriceMicro, maxOffersPerSide: book.maxOffersPerSide };
}
