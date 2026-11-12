import { describe, expect, it } from "vitest";
import { FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import type { BotBook } from "../../src/domain/book.js";
import { offerViolations } from "../../src/domain/offers.js";
import type { Offer } from "../../src/domain/offers.js";
import { computeOffers } from "../../src/domain/pricing.js";
import type { PricingSettings } from "../../src/domain/pricing.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import type { CallContext, OpenMarketsPage, QuotingSettings, Random, ReplaceOffersRequest, ReplaceResult, TradingClient } from "../../src/usecases/ports.js";
import { QuoteMarket } from "../../src/usecases/quote-market.js";
import { KeyedSerializer, STALE_RETRY_ATTEMPTS } from "../../src/usecases/support.js";
import type { QuoteMarketInput, QuoteOutcome } from "../../src/usecases/use-cases.js";
import { FixedRandom, InstantDelay, MARKET_1, MARKET_2, RecordingLogger, TENANT_A, TENANT_B, TestClock, TestSettings, bookOf, credits } from "../support/fakes.js";

const DEFAULTS: PricingSettings = { spreadMicro: 20_000, levels: 3 };

/** A promise the test resolves or rejects by hand. */
function gate(): { promise: Promise<void>; open: () => void; fail: (error: Error) => void } {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

/** Lets every promise chain that can make progress without a timer run to its next wait. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Wraps a trading client: records the PUT bodies and the order of the calls, and can hold the next read or the next PUT
 * until a gate opens (the read of a held GET happens at once, so its answer is the book of that moment).
 */
class SpyTrading implements TradingClient {
  readonly requests: ReplaceOffersRequest[] = [];
  readonly events: string[] = [];
  holdNextBook: Promise<void> | null = null;
  holdNextReplace: Promise<void> | null = null;

  constructor(private readonly inner: TradingClient) {}

  listOpenMarkets(page: { cursor: string | null; limit: number }, context: CallContext): Promise<OpenMarketsPage> {
    return this.inner.listOpenMarkets(page, context);
  }

  async getBotBook(marketId: string, context: CallContext): Promise<BotBook | null> {
    this.events.push(`get ${marketId}`);
    const hold = this.holdNextBook;
    this.holdNextBook = null;
    const book = await this.inner.getBotBook(marketId, context);
    if (hold !== null) await hold;
    return book;
  }

  async replaceBotOrders(marketId: string, request: ReplaceOffersRequest, context: CallContext): Promise<ReplaceResult> {
    this.requests.push(request);
    this.events.push(`put ${marketId}`);
    const hold = this.holdNextReplace;
    this.holdNextReplace = null;
    if (hold !== null) await hold;
    const result = await this.inner.replaceBotOrders(marketId, request, context);
    this.events.push(`done ${marketId}`);
    return result;
  }
}

/** Answers from a script: the books and the PUT results are used in order, the last one repeating. */
class ScriptedTrading implements TradingClient {
  readonly requests: ReplaceOffersRequest[] = [];
  reads = 0;
  constructor(
    private readonly books: Array<BotBook | null>,
    private readonly results: ReplaceResult[] = [],
  ) {}

  listOpenMarkets(): Promise<OpenMarketsPage> {
    return Promise.reject(new Error("the quote run does not list markets"));
  }

  getBotBook(): Promise<BotBook | null> {
    const book = this.books[Math.min(this.reads, this.books.length - 1)] ?? null;
    this.reads += 1;
    return Promise.resolve(book);
  }

  replaceBotOrders(_marketId: string, request: ReplaceOffersRequest): Promise<ReplaceResult> {
    const result = this.results[Math.min(this.requests.length, this.results.length - 1)];
    this.requests.push(request);
    if (result === undefined) return Promise.reject(new Error("no PUT result scripted"));
    return Promise.resolve(result);
  }
}

/** Counts the reads of the settings: one per run. */
class CountingSettings extends TestSettings {
  reads = 0;
  override current(): QuotingSettings {
    this.reads += 1;
    return super.current();
  }
}

function setup(options: { maxOffersPerSide?: number; random?: Random; settings?: TestSettings; serializer?: KeyedSerializer<QuoteOutcome> } = {}) {
  const clock = new TestClock();
  const fake = new FakeTradingClient({ clock, ...(options.maxOffersPerSide === undefined ? {} : { maxOffersPerSide: options.maxOffersPerSide }) });
  fake.addMarket(bookOf().market);
  const trading = new SpyTrading(fake);
  const settings = options.settings ?? new TestSettings();
  const delay = new InstantDelay();
  const logger = new RecordingLogger();
  const quote = new QuoteMarket({ trading, settings, clock, delay, random: options.random ?? new FixedRandom(0.5), logger }, options.serializer);
  return { clock, fake, trading, settings, delay, logger, quote };
}

function scripted(books: Array<BotBook | null>, results: ReplaceResult[] = [], settings: TestSettings = new TestSettings()) {
  const trading = new ScriptedTrading(books, results);
  const clock = new TestClock();
  const delay = new InstantDelay();
  const logger = new RecordingLogger();
  const quote = new QuoteMarket({ trading, settings, clock, delay, random: new FixedRandom(0.5), logger });
  return { trading, delay, logger, quote, settings };
}

const input = (overrides: Partial<QuoteMarketInput> = {}): QuoteMarketInput => ({
  marketId: MARKET_1,
  trigger: "trade_executed",
  tenantId: TENANT_A,
  knownSequence: null,
  correlationId: "corr-1",
  ...overrides,
});

/** The offers the pricing rule gives a book, for comparing with what a run sent. */
function expectedOffers(book: BotBook, settings: PricingSettings = DEFAULTS): Offer[] {
  if (book.market.fundingMicro === null || book.market.startingPriceMicro === null) throw new Error("expected a funded, opened book");
  return computeOffers({ holdings: book.holdings, fundingMicro: book.market.fundingMicro, startingPriceMicro: book.market.startingPriceMicro, maxOffersPerSide: book.maxOffersPerSide }, settings);
}

const perSide = (offers: readonly Offer[], side: "YES" | "NO"): Offer[] => offers.filter((offer) => offer.side === side);
const methods = (fake: FakeTradingClient): string[] => fake.calls.map((call) => call.method);

describe("QuoteMarket: a quote run", () => {
  it("quotes a fresh market with the pricing example: three levels per side at 0.51, 0.52 and 0.53, about 200 shares each", async () => {
    const { quote, fake, logger } = setup();
    const outcome = await quote.execute(input());
    expect(outcome).toEqual({ kind: "quoted", tradeSequence: 0, offers: 6, attempts: 1 });
    const book = fake.book(MARKET_1);
    expect(perSide(book?.offers ?? [], "YES").map((offer) => offer.priceMicro)).toEqual([510_000, 520_000, 530_000]);
    expect(perSide(book?.offers ?? [], "NO").map((offer) => offer.priceMicro)).toEqual([510_000, 520_000, 530_000]);
    for (const offer of book?.offers ?? []) expect(Math.abs(offer.sharesMicro - credits(200))).toBeLessThan(credits(5));
    expect(book?.offers).toEqual(expectedOffers(bookOf()));
    expect(book?.offersPricedOnSequence).toBe(0);
    expect(offerViolations(book?.offers ?? [], book?.holdings ?? { balanceMicro: 0, yesMicro: 0, noMicro: 0 }, 10)).toEqual([]);

    const line = logger.lines.find((entry) => entry.message === "Offers replaced");
    expect(line?.level).toBe("info");
    expect(line?.fields).toMatchObject({
      marketId: MARKET_1,
      tenantId: TENANT_A,
      trigger: "trade_executed",
      correlationId: "corr-1",
      tradeSequence: 0,
      offers: 6,
      referencePriceMicro: 500_000,
      attempts: 1,
    });
  });

  it("sends the correlation id with every call", async () => {
    const { quote, fake } = setup();
    fake.failNext("stale");
    await quote.execute(input({ correlationId: "corr-42" }));
    expect(methods(fake)).toEqual(["book", "replace", "book", "replace"]);
    expect(fake.calls.every((call) => call.correlationId === "corr-42")).toBe(true);
  });

  it("quotes at most the levels trading accepts: two per side at a limit of 2 with LEVELS 5, four after the limit is raised to 4", async () => {
    const { quote, fake, settings } = setup({ maxOffersPerSide: 2 });
    settings.settings = { ...settings.settings, levels: 5 };
    const wide = expectedOffers(bookOf({ maxOffersPerSide: 50 }), { spreadMicro: 20_000, levels: 5 });

    expect(await quote.execute(input())).toMatchObject({ kind: "quoted", offers: 4 });
    expect(fake.book(MARKET_1)?.offers).toEqual([...perSide(wide, "YES").slice(0, 2), ...perSide(wide, "NO").slice(0, 2)]);

    fake.setMaxOffersPerSide(4);
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted", offers: 8 });
    expect(fake.book(MARKET_1)?.offers).toEqual([...perSide(wide, "YES").slice(0, 4), ...perSide(wide, "NO").slice(0, 4)]);
  });

  it("does not send an equal list again", async () => {
    const { quote, fake, trading } = setup();
    await quote.execute(input());
    const outcome = await quote.execute(input({ correlationId: "corr-2" }));
    expect(outcome).toEqual({ kind: "unchanged", tradeSequence: 0 });
    expect(trading.requests).toHaveLength(1);
    expect(methods(fake)).toEqual(["book", "replace", "book"]);
  });

  it("prices on the trade sequence after a trade, never on the sequence the resting offers were priced on", async () => {
    const { quote, fake, trading } = setup();
    await quote.execute(input());
    fake.trade(MARKET_1, "YES", credits(10));
    const traded = fake.book(MARKET_1);
    expect(traded?.tradeSequence).toBe(1);
    expect(traded?.offersPricedOnSequence).toBe(0);

    const outcome = await quote.execute(input({ knownSequence: 1 }));
    expect(outcome).toEqual({ kind: "quoted", tradeSequence: 1, offers: 6, attempts: 1 });
    expect(trading.requests[1]?.basedOnSequence).toBe(1);
    expect(trading.requests[1]?.offers).toEqual(expectedOffers(traded ?? bookOf()));
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBe(1);
    expect(await quote.execute(input())).toEqual({ kind: "unchanged", tradeSequence: 1 });
  });

  it("sends changed settings: a wider spread replaces an equal-priced book", async () => {
    const { quote, settings, trading } = setup();
    await quote.execute(input());
    settings.settings = { ...settings.settings, spreadMicro: 40_000 };
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
    expect(trading.requests).toHaveLength(2);
    expect(trading.requests[1]?.offers).toEqual(expectedOffers(bookOf(), { spreadMicro: 40_000, levels: 3 }));
  });

  it("reads the settings once per run, so every attempt of a run uses the same ones", async () => {
    const settings = new CountingSettings();
    const { quote, fake } = setup({ settings });
    fake.failNext("stale");
    fake.failNext("stale");
    await quote.execute(input());
    expect(settings.reads).toBe(1);
  });
});

describe("QuoteMarket: an equal list and an empty one", () => {
  const funded = bookOf({ tradeSequence: 4 });
  const desired = expectedOffers(funded);

  it("sends an equal list again when it is priced on an older sequence, and not when it is priced on the current one", async () => {
    const old = scripted([bookOf({ tradeSequence: 4, offers: desired, offersPricedOnSequence: 3 })], [{ kind: "replaced", book: bookOf({ tradeSequence: 4, offers: desired }) }]);
    expect(await old.quote.execute(input())).toMatchObject({ kind: "quoted", tradeSequence: 4 });
    expect(old.trading.requests).toEqual([{ basedOnSequence: 4, offers: desired }]);

    const current = scripted([bookOf({ tradeSequence: 4, offers: desired, offersPricedOnSequence: 4 })]);
    expect(await current.quote.execute(input())).toEqual({ kind: "unchanged", tradeSequence: 4 });
    expect(current.trading.requests).toEqual([]);
  });

  it("leaves an empty book alone when the pool is empty, but cancels resting offers then", async () => {
    const emptyHoldings = { balanceMicro: 0, yesMicro: 0, noMicro: 0 };
    const none = scripted([bookOf({ holdings: emptyHoldings, offers: [] })]);
    expect(await none.quote.execute(input())).toEqual({ kind: "unchanged", tradeSequence: 0 });
    expect(none.trading.requests).toEqual([]);

    const resting: Offer[] = [{ side: "YES", priceMicro: 510_000, sharesMicro: credits(1) }];
    const cancel = scripted([bookOf({ holdings: emptyHoldings, offers: resting })], [{ kind: "replaced", book: bookOf({ holdings: emptyHoldings }) }]);
    expect(await cancel.quote.execute(input())).toMatchObject({ kind: "quoted", offers: 0 });
    expect(cancel.trading.requests).toEqual([{ basedOnSequence: 0, offers: [] }]);
  });
});

describe("QuoteMarket: 409 stale_sequence", () => {
  it("reads again after each stale answer and waits a growing, jittered time", async () => {
    const { quote, fake, delay } = setup();
    fake.failNext("stale");
    fake.failNext("stale");
    const outcome = await quote.execute(input());
    expect(outcome).toEqual({ kind: "quoted", tradeSequence: 0, offers: 6, attempts: 3 });
    expect(methods(fake)).toEqual(["book", "replace", "book", "replace", "book", "replace"]);
    // 100 ms x attempt x (0.5 + 0.5): 100 then 200.
    expect(delay.waits).toEqual([100, 200]);
  });

  it("draws the jitter from the random source: 0.5 to 1.5 times the base", async () => {
    const low = setup({ random: new FixedRandom(0) });
    low.fake.failNext("stale");
    low.fake.failNext("stale");
    await low.quote.execute(input());
    expect(low.delay.waits).toEqual([50, 100]);

    const high = setup({ random: new FixedRandom(0.999) });
    high.fake.failNext("stale");
    await high.quote.execute(input());
    expect(high.delay.waits).toEqual([149]);
  });

  it("recovers from a real trade between the read and the PUT", async () => {
    const { quote, fake, trading } = setup();
    await quote.execute(input());
    fake.trade(MARKET_1, "NO", credits(10));
    // The next read answers at once but late: a second trade lands before the PUT.
    const held = gate();
    trading.holdNextBook = held.promise;
    const run = quote.execute(input());
    await settle();
    fake.trade(MARKET_1, "YES", credits(5));
    held.open();
    expect(await run).toEqual({ kind: "quoted", tradeSequence: 2, offers: 6, attempts: 2 });
    expect(fake.book(MARKET_1)?.tradeSequence).toBe(2);
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBe(2);
  });

  it("gives up as contended after five stale answers, without a wait after the last", async () => {
    const { quote, fake, delay, logger } = setup();
    for (let attempt = 0; attempt < STALE_RETRY_ATTEMPTS; attempt += 1) fake.failNext("stale");
    const outcome = await quote.execute(input());
    expect(outcome).toEqual({ kind: "contended", attempts: 5 });
    expect(methods(fake)).toEqual(["book", "replace", "book", "replace", "book", "replace", "book", "replace", "book", "replace"]);
    expect(delay.waits).toEqual([100, 200, 300, 400]);
    expect(logger.lines.filter((line) => line.level === "warn").map((line) => line.message)).toEqual(["Gave up after repeated stale trade sequences"]);
    // The book is untouched, and the next run quotes it.
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted", attempts: 1 });
  });

  it("ends as stopped when the market closed between the stale answer and the next read", async () => {
    const { quote, fake, trading } = setup();
    fake.failNext("stale");
    const held = gate();
    trading.holdNextReplace = held.promise;
    const run = quote.execute(input());
    await settle();
    fake.setStatus(MARKET_1, "closed");
    held.open();
    expect(await run).toEqual({ kind: "stopped", reason: "closed" });
    expect(methods(fake)).toEqual(["book", "replace", "book"]);
  });
});

describe("QuoteMarket: a market that is not quoted", () => {
  it.each([["closed"], ["resolved"]] as const)("stops without a PUT for a %s market", async (status) => {
    const { quote, fake, logger } = setup();
    fake.setStatus(MARKET_1, status);
    expect(await quote.execute(input())).toEqual({ kind: "stopped", reason: status });
    expect(methods(fake)).toEqual(["book"]);
    expect(logger.lines.find((line) => line.message === "Market is not quoted any more")?.level).toBe("info");
  });

  it("stops without a PUT once the close time has come", async () => {
    const { quote, fake, clock } = setup();
    const closeTime = fake.book(MARKET_1)?.market.closeTime;
    if (closeTime === null || closeTime === undefined) throw new Error("expected a close time");
    clock.advanceMs(closeTime.getTime() - clock.now().getTime());
    expect(await quote.execute(input())).toEqual({ kind: "stopped", reason: "past_close_time" });
    expect(methods(fake)).toEqual(["book"]);
  });

  it("stops when trading answers market_not_open to the PUT", async () => {
    const { quote, trading, logger } = scripted([bookOf()], [{ kind: "market_not_open" }]);
    expect(await quote.execute(input())).toEqual({ kind: "stopped", reason: "market_not_open" });
    expect(trading.requests).toHaveLength(1);
    expect(logger.lines.at(-1)).toMatchObject({ level: "info", fields: { reason: "market_not_open" } });
  });

  it("answers not_found when trading knows no such market, on the read and on the PUT", async () => {
    const { quote, fake, logger } = setup();
    expect(await quote.execute(input({ marketId: MARKET_2 }))).toEqual({ kind: "not_found" });
    expect(methods(fake)).toEqual(["book"]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", message: "Market not found" });

    const put = scripted([bookOf()], [{ kind: "not_found" }]);
    expect(await put.quote.execute(input())).toEqual({ kind: "not_found" });
    expect(put.trading.requests).toHaveLength(1);
    expect(put.logger.lines.at(-1)).toMatchObject({ level: "warn", message: "Market not found" });
  });

  it("is not ready while the funded copy has no starting price yet, or the market is not funded", async () => {
    const early = scripted([bookOf({ status: "funded", startingPriceMicro: null })]);
    expect(await early.quote.execute(input())).toEqual({ kind: "not_ready", reason: "no_starting_price" });
    expect(early.trading.requests).toEqual([]);
    expect(early.logger.lines.at(-1)).toMatchObject({ level: "info", fields: { reason: "no_starting_price" } });

    const unfunded = scripted([bookOf({ fundingCredits: null })]);
    expect(await unfunded.quote.execute(input())).toEqual({ kind: "not_ready", reason: "not_funded" });
  });

  it("quotes a funded copy as soon as it has a starting price: trading accepts offers that rest until the market opens", async () => {
    const { quote, fake } = setup();
    fake.addMarket(bookOf({ status: "funded" }).market);
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
    expect(fake.book(MARKET_1)?.offers).toHaveLength(6);
  });

  it("makes no call at all while quoting is disabled, and quotes again when it is switched on", async () => {
    const { quote, fake, settings, logger } = setup();
    settings.settings = { ...settings.settings, enabled: false };
    expect(await quote.execute(input())).toEqual({ kind: "disabled" });
    expect(fake.calls).toEqual([]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "debug", message: "Quoting is disabled" });
    settings.settings = { ...settings.settings, enabled: true };
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
  });
});

describe("QuoteMarket: refusals and defects", () => {
  it.each([
    [{ kind: "refused", status: 400, code: "validation_failed", detail: "At most 2 offers per side" }],
    [{ kind: "refused", status: 400, code: "crossed_offers", detail: "crossed" }],
    [{ kind: "refused", status: 409, code: "insufficient_holdings", detail: "cannot back" }],
    [{ kind: "refused", status: 400, code: null, detail: "no code" }],
  ] satisfies Array<[ReplaceResult]>)("passes on a refusal by trading and logs it as an error: %j", async (result) => {
    const { quote, trading, logger, delay } = scripted([bookOf()], [result]);
    const outcome = await quote.execute(input());
    expect(outcome).toEqual(result);
    expect(trading.requests).toHaveLength(1);
    expect(delay.waits).toEqual([]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "trading refused the offers", fields: { status: result.status, code: result.code, detail: result.detail, marketId: MARKET_1 } });
  });

  it("refuses a book it cannot price (a DomainError) without sending anything, so a recheck can go on with the other markets", async () => {
    const settings = new TestSettings();
    settings.settings = { ...settings.settings, spreadMicro: 0 };
    const { quote, trading, logger } = scripted([bookOf()], [], settings);
    expect(await quote.execute(input())).toEqual({ kind: "refused", status: 0, code: "invalid_input", detail: expect.stringContaining("spreadMicro") as string });
    expect(trading.requests).toEqual([]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "The offers could not be computed" });

    const zeroFunding = scripted([bookOf({ fundingCredits: 0 })]);
    expect(await zeroFunding.quote.execute(input())).toMatchObject({ kind: "refused", status: 0, code: "invalid_input" });
  });
});

describe("QuoteMarket: the tenant", () => {
  it("quotes a book of another tenant than the notification's and logs it once, with the book's tenant", async () => {
    const { quote, fake, logger } = setup();
    fake.failNext("stale");
    const outcome = await quote.execute(input({ tenantId: TENANT_B }));
    expect(outcome).toMatchObject({ kind: "quoted", attempts: 2 });
    const warnings = logger.lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ tenantId: TENANT_A, eventTenantId: TENANT_B, marketId: MARKET_1 });
  });

  it("does not warn when the notification names no tenant or the same one", async () => {
    const { quote, logger } = setup();
    await quote.execute(input({ tenantId: null }));
    await quote.execute(input({ tenantId: TENANT_A }));
    expect(logger.lines.filter((line) => line.level === "warn")).toEqual([]);
  });
});

describe("QuoteMarket: failures of trading", () => {
  it("passes TradingUnavailable and TradingContractViolation on, and runs again afterwards", async () => {
    const serializer = new KeyedSerializer<QuoteOutcome>();
    const { quote, fake } = setup({ serializer });
    fake.failNext("unavailable");
    await expect(quote.execute(input())).rejects.toBeInstanceOf(TradingUnavailable);
    fake.failNext("unavailable_service");
    await expect(quote.execute(input())).rejects.toMatchObject({ scope: "service" });
    fake.failNext("contract", { method: "replace" });
    await expect(quote.execute(input())).rejects.toBeInstanceOf(TradingContractViolation);
    expect(serializer.activeKeys).toBe(0);
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
  });
});

describe("QuoteMarket: two notifications for one market", () => {
  it("never overlaps two runs of one market: the second reads after the first run's PUT, and finds nothing to send", async () => {
    const { quote, trading, fake } = setup();
    const held = gate();
    trading.holdNextReplace = held.promise;
    const first = quote.execute(input({ correlationId: "n-1" }));
    await settle();
    const second = quote.execute(input({ correlationId: "n-2" }));
    await settle();
    // The first run has read and sent its PUT (still held); the second has not started.
    expect(trading.events).toEqual([`get ${MARKET_1}`, `put ${MARKET_1}`]);

    held.open();
    expect(await first).toMatchObject({ kind: "quoted" });
    expect(await second).toEqual({ kind: "unchanged", tradeSequence: 0 });
    expect(trading.events).toEqual([`get ${MARKET_1}`, `put ${MARKET_1}`, `done ${MARKET_1}`, `get ${MARKET_1}`]);
    expect(methods(fake)).toEqual(["book", "replace", "book"]);
  });

  it("lets three notifications share two runs: the two that arrive while one runs share the waiting run", async () => {
    const serializer = new KeyedSerializer<QuoteOutcome>();
    const { quote, trading, fake, delay } = setup({ serializer });
    await quote.execute(input());
    fake.trade(MARKET_1, "YES", credits(10));

    // The first notification's read answers late; a second trade lands before its PUT, and two more notifications arrive.
    const held = gate();
    trading.holdNextBook = held.promise;
    const first = quote.execute(input({ correlationId: "n-1", knownSequence: 1 }));
    await settle();
    fake.trade(MARKET_1, "NO", credits(10));
    const second = quote.execute(input({ correlationId: "n-2", knownSequence: 2 }));
    const third = quote.execute(input({ correlationId: "n-3", knownSequence: 2 }));
    expect(second).toBe(third);
    expect(serializer.activeKeys).toBe(1);

    held.open();
    expect(await first).toEqual({ kind: "quoted", tradeSequence: 2, offers: 6, attempts: 2 });
    expect(await second).toEqual({ kind: "unchanged", tradeSequence: 2 });
    expect(await third).toEqual({ kind: "unchanged", tradeSequence: 2 });
    // Run 0 (get, put), the first notification (get, stale put, get, put) and one shared run (get): two runs for three notifications.
    expect(methods(fake)).toEqual(["book", "replace", "book", "replace", "book", "replace", "book"]);
    expect(delay.waits).toEqual([100]);
    expect(serializer.activeKeys).toBe(0);
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBe(2);
  });

  it("lets runs of different markets go on side by side", async () => {
    const { quote, trading, fake } = setup();
    fake.addMarket(bookOf({ marketId: MARKET_2 }).market);
    const held = gate();
    trading.holdNextBook = held.promise;
    const slow = quote.execute(input({ marketId: MARKET_1 }));
    await settle();
    // MARKET_1's read is held, yet MARKET_2 is quoted completely.
    expect(await quote.execute(input({ marketId: MARKET_2 }))).toMatchObject({ kind: "quoted" });
    expect(fake.book(MARKET_2)?.offers).toHaveLength(6);
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    held.open();
    expect(await slow).toMatchObject({ kind: "quoted" });
  });

  it("does not pass the failure of the run in progress on to the waiting run", async () => {
    const { quote, trading, fake } = setup();
    const held = gate();
    trading.holdNextBook = held.promise;
    const first = quote.execute(input({ correlationId: "n-1" }));
    await settle();
    const second = quote.execute(input({ correlationId: "n-2" }));
    held.fail(new TradingUnavailable("trading went away"));
    await expect(first).rejects.toBeInstanceOf(TradingUnavailable);
    expect(await second).toMatchObject({ kind: "quoted" });
    expect(fake.book(MARKET_1)?.offers).toHaveLength(6);
  });
});
