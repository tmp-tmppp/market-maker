import type { BotBook, BotMarket, Holdings, MarketStatus } from "../../domain/book.js";
import { TRADING_DEFAULT_MAX_OFFERS_PER_SIDE, offerViolations, sortOffers } from "../../domain/offers.js";
import type { Offer } from "../../domain/offers.js";
import { MICROS_PER_UNIT } from "../../domain/units.js";
import type { Side } from "../../domain/units.js";
import { TradingContractViolation, TradingUnavailable } from "../../usecases/errors.js";
import type { CallContext, Clock, OpenMarketsPage, ReplaceOffersRequest, ReplaceResult, TradingClient } from "../../usecases/ports.js";

// An in-memory stand-in for trading's internal API (contracts/outgoing/trading-bot.openapi.yaml), with trading's
// semantics for the three calls the bot makes. It serves the use-case tests and the local mode of the service
// (APP_ENV=local without TRADING_URL), where `withDemoMarket` gives the bot one open market to quote. It is not a
// second implementation of trading: it keeps only what the bot's calls can observe (the market copy, the bot account's
// holdings, the resting offers and the trade sequence).

/** The demo market of the local mode: its tenant and market ids are fixed so a log line can be matched by hand. */
export const DEMO_TENANT_ID = "00000000-0000-7000-8000-00000000d3a0";
export const DEMO_MARKET_ID = "00000000-0000-7000-8000-00000000d3a1";
const DEMO_FUNDING_CREDITS = 5000;
const DEMO_STARTING_PRICE_MICRO = 600_000;
const DEMO_OPEN_DAYS = 30;

/** The most trading returns per list page (its contract: limit 1..500). */
const MAX_PAGE_SIZE = 500;
const MAX_OFFERS_PER_SIDE_LIMIT = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CallMethod = "list" | "book" | "replace";

/** One call the fake received, in order; failed and injected calls are recorded too. */
export interface RecordedCall {
  method: CallMethod;
  /** Null for the list call. */
  marketId: string | null;
  correlationId: string;
}

/**
 * What `failNext` makes happen: "unavailable" and "unavailable_service" throw TradingUnavailable (scope "call" and
 * "service"), "contract" throws TradingContractViolation, "stale" answers one 409 stale_sequence to a replacement
 * without any trade having happened (the next attempt, which reads the book again, succeeds).
 */
export type InjectedFailure = "unavailable" | "unavailable_service" | "contract" | "stale";

export interface FailNextOptions {
  /** Only a call of this method triggers it ("stale" always means a replacement). */
  method?: CallMethod;
  /** Only a call about this market triggers it. */
  marketId?: string;
}

export interface FakeTradingClientOptions {
  clock: Clock;
  /** trading's runtime MAX_OFFERS_PER_SIDE as every book reports it; default 10 (its default). */
  maxOffersPerSide?: number;
}

interface StoredMarket {
  market: BotMarket;
  holdings: Holdings;
  offers: Offer[];
  /** The sequence the resting offers were priced on; null without offers. */
  pricedOnSequence: number | null;
}

interface PendingFailure extends FailNextOptions {
  kind: InjectedFailure;
}

const copyOffers = (offers: readonly Offer[]): Offer[] => offers.map((offer) => ({ ...offer }));
const copyMarket = (market: BotMarket): BotMarket => ({ ...market, closeTime: market.closeTime === null ? null : new Date(market.closeTime) });

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OFFERS_PER_SIDE_LIMIT) throw new RangeError(`maxOffersPerSide must be an integer from 1 to ${MAX_OFFERS_PER_SIDE_LIMIT}`);
}

/** ceil(shares x price / 10^6) microcredits: what trading charges for a fill (ADR-055). */
function costOfFill(sharesMicro: number, priceMicro: number): bigint {
  return (BigInt(sharesMicro) * BigInt(priceMicro) + BigInt(MICROS_PER_UNIT - 1)) / BigInt(MICROS_PER_UNIT);
}

const encodeCursor = (market: BotMarket): string => Buffer.from(JSON.stringify([market.tenantId, market.marketId])).toString("base64url");

function decodeCursor(cursor: string): { tenantId: string; marketId: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") return { tenantId: value[0], marketId: value[1] };
  } catch {
    // Falls through to the violation below.
  }
  throw new TradingContractViolation("The cursor is not one this server issued");
}

/** Order of the list: tenant id, then market id (trading's `ListOpenMarkets`). */
function byTenantThenMarket(a: { tenantId: string; marketId: string }, b: { tenantId: string; marketId: string }): number {
  if (a.tenantId !== b.tenantId) return a.tenantId < b.tenantId ? -1 : 1;
  if (a.marketId !== b.marketId) return a.marketId < b.marketId ? -1 : 1;
  return 0;
}

/** Sorts the lines of `offerViolations` into trading's refusal kinds, in the order trading checks them. */
function refusalOf(problems: readonly string[]): { status: number; code: string; detail: string } {
  const backing = problems.filter((problem) => problem.includes("bot account can deliver"));
  const crossed = problems.filter((problem) => problem.startsWith("crossed:"));
  const validation = problems.filter((problem) => !backing.includes(problem) && !crossed.includes(problem));
  if (validation.length > 0) return { status: 400, code: "validation_failed", detail: validation.join("; ") };
  if (crossed.length > 0) return { status: 400, code: "crossed_offers", detail: crossed.join("; ") };
  return { status: 409, code: "insufficient_holdings", detail: backing.join("; ") };
}

export class FakeTradingClient implements TradingClient {
  /** Every call in order (also the ones that threw), for the tests' order and count checks. */
  readonly calls: RecordedCall[] = [];

  private readonly clock: Clock;
  private maxOffersPerSide: number;
  private readonly markets = new Map<string, StoredMarket>();
  private readonly pending: PendingFailure[] = [];
  private readonly failingMarkets = new Map<string, "unavailable" | "contract">();

  constructor(options: FakeTradingClientOptions) {
    this.clock = options.clock;
    this.maxOffersPerSide = options.maxOffersPerSide ?? TRADING_DEFAULT_MAX_OFFERS_PER_SIDE;
    requireLimit(this.maxOffersPerSide);
  }

  /** The local mode: one open market of a fixed demo tenant, 5000 credits at 0.60, closing 30 days after the clock. */
  static withDemoMarket(clock: Clock): FakeTradingClient {
    const client = new FakeTradingClient({ clock });
    client.addMarket({
      marketId: DEMO_MARKET_ID,
      tenantId: DEMO_TENANT_ID,
      status: "open",
      version: 1,
      closeTime: new Date(clock.now().getTime() + DEMO_OPEN_DAYS * MS_PER_DAY),
      startingPriceMicro: DEMO_STARTING_PRICE_MICRO,
      fundingMicro: DEMO_FUNDING_CREDITS * MICROS_PER_UNIT,
      tradeSequence: 0,
    });
    return client;
  }

  /**
   * Adds a market, or replaces the one with the same id (with no offers). The default holdings are what the funding
   * call leaves: the funding as pairs and no credits.
   */
  addMarket(market: BotMarket, holdings?: Holdings): void {
    const funding = market.fundingMicro ?? 0;
    this.markets.set(market.marketId, {
      market: copyMarket(market),
      holdings: holdings === undefined ? { balanceMicro: 0, yesMicro: funding, noMicro: funding } : { ...holdings },
      offers: [],
      pricedOnSequence: null,
    });
  }

  /** The book as GET bot-book returns it now (a copy); null for an unknown market. */
  book(marketId: string): BotBook | null {
    const stored = this.markets.get(marketId);
    return stored === undefined ? null : this.snapshot(stored);
  }

  /**
   * A trader buys `sharesMicro` of `side` from the bot, as trading fills it: from the cheapest offer up, each fill
   * costing ceil(shares x price / 10^6), the payment added to the bot's credits, the pairs the bot lacks created from
   * its credits, the offers reduced and the trade sequence raised by one. `offersPricedOnSequence` is kept (a fill does
   * not reprice the book). A test mistake (market not open, more than the offers hold) throws a plain Error.
   */
  trade(marketId: string, side: Side, sharesMicro: number): void {
    const stored = this.require(marketId);
    if (stored.market.status !== "open") throw new Error(`The market ${marketId} is ${stored.market.status}, not open`);
    if (!Number.isSafeInteger(sharesMicro) || sharesMicro < 1) throw new Error("A trade needs a positive safe number of microshares");

    const used = new Map<number, number>();
    let left = sharesMicro;
    let cost = 0n;
    for (const level of sortOffers(stored.offers).filter((offer) => offer.side === side)) {
      if (left === 0) break;
      const take = Math.min(level.sharesMicro, left);
      cost += costOfFill(take, level.priceMicro);
      used.set(level.priceMicro, take);
      left -= take;
    }
    if (left > 0) throw new Error(`The offers of ${side} cannot fill ${sharesMicro} microshares`);

    const costMicro = Number(cost);
    const heldKey = side === "YES" ? "yesMicro" : "noMicro";
    const otherKey = side === "YES" ? "noMicro" : "yesMicro";
    // A book that passed the backing check of the replacement always holds enough shares and credits for these pairs.
    const pairs = Math.max(0, sharesMicro - stored.holdings[heldKey]);
    stored.holdings.balanceMicro += costMicro - pairs;
    stored.holdings[heldKey] += pairs - sharesMicro;
    stored.holdings[otherKey] += pairs;

    stored.offers = stored.offers
      .map((offer) => (offer.side === side && used.has(offer.priceMicro) ? { ...offer, sharesMicro: offer.sharesMicro - (used.get(offer.priceMicro) ?? 0) } : offer))
      .filter((offer) => offer.sharesMicro > 0);
    if (stored.offers.length === 0) stored.pricedOnSequence = null;
    stored.market.tradeSequence += 1;
  }

  /** A market event as trading applies it; closing or resolving cancels every offer (trading does that itself). */
  setStatus(marketId: string, status: MarketStatus): void {
    const stored = this.require(marketId);
    stored.market.status = status;
    stored.market.version += 1;
    if (status === "closed" || status === "resolved") {
      stored.offers = [];
      stored.pricedOnSequence = null;
    }
  }

  /** The runtime change of trading's MAX_OFFERS_PER_SIDE: the next book and the next replacement use it. */
  setMaxOffersPerSide(limit: number): void {
    requireLimit(limit);
    this.maxOffersPerSide = limit;
  }

  /**
   * The next call that fits (`options`) fails as `kind` says; several calls queue up, each taking the first queued
   * failure that fits it.
   */
  failNext(kind: InjectedFailure, options: FailNextOptions = {}): void {
    this.pending.push({ kind, ...options });
  }

  /** Every GET bot-book of the market fails as `kind` says until it is cleared with null. */
  failMarket(marketId: string, kind: "unavailable" | "contract" | null): void {
    if (kind === null) this.failingMarkets.delete(marketId);
    else this.failingMarkets.set(marketId, kind);
  }

  listOpenMarkets(page: { cursor: string | null; limit: number }, context: CallContext): Promise<OpenMarketsPage> {
    return this.answer(() => {
      this.begin("list", null, context);
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE_SIZE) throw new TradingContractViolation(`The limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
      const after = page.cursor === null ? null : decodeCursor(page.cursor);
      const open = [...this.markets.values()]
        .map((stored) => stored.market)
        .filter((market) => market.status === "open")
        .sort(byTenantThenMarket)
        .filter((market) => after === null || byTenantThenMarket(market, after) > 0);
      // The cursor names the last item of the page; a next page exists when the open markets outnumber the page.
      const items = open.slice(0, page.limit).map(copyMarket);
      const last = items[items.length - 1];
      return { items, nextCursor: open.length > page.limit && last !== undefined ? encodeCursor(last) : null };
    });
  }

  getBotBook(marketId: string, context: CallContext): Promise<BotBook | null> {
    return this.answer(() => {
      this.begin("book", marketId, context);
      const failing = this.failingMarkets.get(marketId);
      if (failing === "unavailable") throw new TradingUnavailable(`trading is unavailable for ${marketId} (fake)`);
      if (failing === "contract") throw new TradingContractViolation(`trading answered outside its contract for ${marketId} (fake)`);
      return this.book(marketId);
    });
  }

  replaceBotOrders(marketId: string, request: ReplaceOffersRequest, context: CallContext): Promise<ReplaceResult> {
    return this.answer((): ReplaceResult => {
      const injected = this.begin("replace", marketId, context);
      const stored = this.markets.get(marketId);
      if (stored === undefined) return { kind: "not_found" };
      const { market } = stored;
      if (injected === "stale" || request.basedOnSequence !== market.tradeSequence) return { kind: "stale_sequence", tradeSequence: market.tradeSequence };
      const accepting = market.status === "funded" || market.status === "open";
      const pastClose = market.closeTime !== null && this.clock.now().getTime() >= market.closeTime.getTime();
      if (!accepting || market.fundingMicro === null || pastClose) return { kind: "market_not_open" };
      const problems = offerViolations(request.offers, stored.holdings, this.maxOffersPerSide);
      if (problems.length > 0) return { kind: "refused", ...refusalOf(problems) };
      stored.offers = copyOffers(sortOffers(request.offers));
      stored.pricedOnSequence = stored.offers.length === 0 ? null : market.tradeSequence;
      return { kind: "replaced", book: this.snapshot(stored) };
    });
  }

  /** Records the call and throws the queued failure that fits it; returns "stale" for a replacement that must answer 409. */
  private begin(method: CallMethod, marketId: string | null, context: CallContext): "stale" | null {
    this.calls.push({ method, marketId, correlationId: context.correlationId });
    const index = this.pending.findIndex(
      (failure) =>
        (failure.method === undefined || failure.method === method) &&
        (failure.marketId === undefined || failure.marketId === marketId) &&
        (failure.kind !== "stale" || method === "replace"),
    );
    const [failure] = index < 0 ? [] : this.pending.splice(index, 1);
    switch (failure?.kind) {
      case "unavailable":
        throw new TradingUnavailable("trading is unavailable (fake)");
      case "unavailable_service":
        throw new TradingUnavailable("trading is unavailable for every call (fake)", { scope: "service" });
      case "contract":
        throw new TradingContractViolation("trading answered outside its contract (fake)");
      case "stale":
        return "stale";
      default:
        return null;
    }
  }

  /** A thrown failure reaches the caller as a rejected promise, as an HTTP client's would. */
  private answer<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private require(marketId: string): StoredMarket {
    const stored = this.markets.get(marketId);
    if (stored === undefined) throw new Error(`The fake knows no market ${marketId}`);
    return stored;
  }

  private snapshot(stored: StoredMarket): BotBook {
    return {
      market: copyMarket(stored.market),
      holdings: { ...stored.holdings },
      offers: copyOffers(stored.offers),
      tradeSequence: stored.market.tradeSequence,
      offersPricedOnSequence: stored.offers.length === 0 ? null : stored.pricedOnSequence,
      maxOffersPerSide: this.maxOffersPerSide,
    };
  }
}
