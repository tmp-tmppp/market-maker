import { describe, expect, it } from "vitest";
import { FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import { TradingHttpClient } from "../../src/adapters/trading/trading-http-client.js";
import type { TradingPolicyConfig } from "../../src/config.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import type { BotBook } from "../../src/domain/book.js";
import type { CallContext, OpenMarketsPage, ReplaceOffersRequest, ReplaceResult, TradingClient } from "../../src/usecases/ports.js";
import { QuoteMarket } from "../../src/usecases/quote-market.js";
import { RecheckOpenMarkets } from "../../src/usecases/recheck-open-markets.js";
import { LIST_PAGE_SIZE } from "../../src/usecases/support.js";
import type { QuoteMarketInput, QuoteMarketUseCase, QuoteOutcome, RecheckSummary } from "../../src/usecases/use-cases.js";
import { FixedRandom, InstantDelay, RecordingLogger, TENANT_A, TENANT_B, TestClock, TestSettings, bookOf, credits } from "../support/fakes.js";

const TENANT_C = "018f3c1e-7a00-7000-8000-0000000000cc";
const marketId = (n: number): string => `018f3c1e-7a00-7000-8000-${(0x1000 + n).toString(16).padStart(12, "0")}`;

const ZEROS = { markets: 0, quoted: 0, unchanged: 0, stopped: 0, notReady: 0, notFound: 0, contended: 0, refused: 0, failed: 0 };
const summaryOf = (changes: Partial<RecheckSummary>): RecheckSummary => ({ disabled: false, completed: true, ...ZEROS, failure: null, ...changes });

/** Wraps a trading client and fails one chosen list call (counted over the life of the wrapper). */
class FlakyList implements TradingClient {
  listCalls = 0;
  failOnListCall: number | null = null;
  failure: Error = new TradingUnavailable("the list call failed");
  constructor(private readonly inner: TradingClient) {}
  listOpenMarkets(page: { cursor: string | null; limit: number }, context: CallContext): Promise<OpenMarketsPage> {
    this.listCalls += 1;
    return this.listCalls === this.failOnListCall ? Promise.reject(this.failure) : this.inner.listOpenMarkets(page, context);
  }
  getBotBook(marketId: string, context: CallContext): Promise<BotBook | null> {
    return this.inner.getBotBook(marketId, context);
  }
  replaceBotOrders(marketId: string, request: ReplaceOffersRequest, context: CallContext): Promise<ReplaceResult> {
    return this.inner.replaceBotOrders(marketId, request, context);
  }
}

/** Answers per market from a script (an outcome or a failure) and records what it was asked for. */
class ScriptedQuote implements QuoteMarketUseCase {
  readonly inputs: QuoteMarketInput[] = [];
  readonly script = new Map<string, QuoteOutcome | Error>();
  onExecute: ((input: QuoteMarketInput) => void) | null = null;
  execute(input: QuoteMarketInput): Promise<QuoteOutcome> {
    this.inputs.push(input);
    this.onExecute?.(input);
    const planned = this.script.get(input.marketId);
    if (planned instanceof Error) return Promise.reject(planned);
    return Promise.resolve(planned ?? { kind: "unchanged", tradeSequence: input.knownSequence ?? 0 });
  }
  get order(): string[] {
    return this.inputs.map((input) => input.marketId);
  }
  clear(): void {
    this.inputs.length = 0;
  }
}

/** 120 open markets of three tenants (50, 50 and 20): the list has two pages of 100 and 20, and the position of a market is its index in `ALL`. */
function listOf120() {
  const clock = new TestClock();
  const fake = new FakeTradingClient({ clock });
  const ids: string[] = [];
  const tenants = [
    [TENANT_A, 50],
    [TENANT_B, 50],
    [TENANT_C, 20],
  ] as const;
  let n = 0;
  for (const [tenantId, count] of tenants) {
    for (let index = 0; index < count; index += 1) {
      const id = marketId(n);
      n += 1;
      ids.push(id);
      fake.addMarket(bookOf({ marketId: id, tenantId }).market);
    }
  }
  return { clock, fake, ALL: ids };
}

function stubbed(fake: TradingClient, settings = new TestSettings()) {
  const quote = new ScriptedQuote();
  const logger = new RecordingLogger();
  const recheck = new RecheckOpenMarkets({ trading: fake, settings, quote, logger });
  return { quote, logger, settings, recheck };
}

const run = (recheck: RecheckOpenMarkets, extra: { shouldStop?: () => boolean } = {}) => recheck.execute({ correlationId: "run-1", ...extra });
const listCalls = (fake: FakeTradingClient): number => fake.calls.filter((call) => call.method === "list").length;

describe("RecheckOpenMarkets: listing and counting", () => {
  it("lists two pages and runs a quote for every market in list order, with the list's tenant and sequence and one correlation id", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    const summary = await run(recheck);
    expect(summary).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    expect(quote.order).toEqual(ALL);
    expect(listCalls(fake)).toBe(2);
    expect(quote.inputs[0]).toEqual({ marketId: ALL[0], trigger: "recheck", tenantId: TENANT_A, knownSequence: 0, correlationId: "run-1" });
    expect(quote.inputs[119]).toMatchObject({ marketId: ALL[119], tenantId: TENANT_C });
    expect(new Set(quote.inputs.map((input) => input.correlationId))).toEqual(new Set(["run-1"]));
    // The fixture assumes the page size of 100: 120 markets are two pages.
    expect(LIST_PAGE_SIZE).toBe(100);
  });

  it("counts the outcomes by kind", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[0] ?? "", { kind: "quoted", tradeSequence: 0, offers: 6, attempts: 1 });
    quote.script.set(ALL[1] ?? "", { kind: "stopped", reason: "closed" });
    quote.script.set(ALL[2] ?? "", { kind: "not_ready", reason: "no_starting_price" });
    quote.script.set(ALL[3] ?? "", { kind: "not_found" });
    quote.script.set(ALL[4] ?? "", { kind: "contended", attempts: 5 });
    quote.script.set(ALL[5] ?? "", { kind: "refused", status: 400, code: null, detail: "x" });
    quote.script.set(ALL[105] ?? "", { kind: "quoted", tradeSequence: 0, offers: 6, attempts: 2 });
    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, quoted: 2, stopped: 1, notReady: 1, notFound: 1, contended: 1, refused: 1, unchanged: 113 }));
  });

  it.each([
    [0, 1],
    [100, 1],
    [101, 2],
  ])("lists a page more only when markets are left: %i open markets take %i list call(s)", async (count, calls) => {
    const clock = new TestClock();
    const fake = new FakeTradingClient({ clock });
    for (let n = 0; n < count; n += 1) fake.addMarket(bookOf({ marketId: marketId(n) }).market);
    const { quote, recheck } = stubbed(fake);
    expect(await run(recheck)).toEqual(summaryOf({ markets: count, unchanged: count }));
    expect(quote.inputs).toHaveLength(count);
    expect(listCalls(fake)).toBe(calls);
  });

  it("makes no call while quoting is disabled", async () => {
    const { fake } = listOf120();
    const { quote, recheck, settings } = stubbed(fake);
    settings.settings = { ...settings.settings, enabled: false };
    expect(await run(recheck)).toEqual(summaryOf({ disabled: true }));
    expect(fake.calls).toEqual([]);
    expect(quote.inputs).toEqual([]);
  });

  it("stops listing when the kill switch is turned on during the run, and starts from the beginning when it is turned off again", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck, settings } = stubbed(fake);
    quote.script.set(ALL[2] ?? "", { kind: "disabled" });
    quote.onExecute = (input) => {
      if (input.marketId === ALL[2]) settings.settings = { ...settings.settings, enabled: false };
    };
    expect(await run(recheck)).toEqual(summaryOf({ disabled: true, markets: 2, unchanged: 2 }));
    expect(quote.order).toEqual(ALL.slice(0, 3));
    expect(listCalls(fake)).toBe(1);

    quote.clear();
    expect(await run(recheck)).toEqual(summaryOf({ disabled: true }));
    expect(quote.inputs).toEqual([]);

    settings.settings = { ...settings.settings, enabled: true };
    quote.script.clear();
    quote.onExecute = null;
    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    expect(quote.order).toEqual(ALL);
  });
});

describe("RecheckOpenMarkets: a market that fails does not starve the ones after it", () => {
  it("counts a TradingUnavailable of the call and a TradingContractViolation, quotes every other market and completes", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck, logger } = stubbed(fake);
    quote.script.set(ALL[10] ?? "", new TradingUnavailable("timeout after 3000 ms"));
    quote.script.set(ALL[60] ?? "", new TradingContractViolation("field market.status is not a status"));
    const summary = await run(recheck);
    expect(summary).toEqual(summaryOf({ markets: 120, unchanged: 118, failed: 2 }));
    expect(quote.order).toEqual(ALL);
    expect(logger.lines.filter((line) => line.level === "warn")).toEqual([
      { level: "warn", message: "Recheck of one market failed: trading is unavailable for the call", fields: { marketId: ALL[10], tenantId: TENANT_A, correlationId: "run-1", errorName: "TradingUnavailable", errorMessage: "timeout after 3000 ms" } },
    ]);
    expect(logger.lines.filter((line) => line.level === "error")).toEqual([
      { level: "error", message: "Recheck of one market failed: trading answered outside its contract", fields: { marketId: ALL[60], tenantId: TENANT_B, correlationId: "run-1", errorName: "TradingContractViolation", errorMessage: "field market.status is not a status" } },
    ]);

    // A completed run leaves nothing to resume: the next one starts at the first market.
    quote.clear();
    quote.script.clear();
    await run(recheck);
    expect(quote.order).toEqual(ALL);
  });

  it("passes over a market whose read always fails, on either side of the page boundary, with the real quote run", async () => {
    const { clock, fake, ALL } = listOf120();
    const settings = new TestSettings();
    const logger = new RecordingLogger();
    const quote = new QuoteMarket({ trading: fake, settings, clock, delay: new InstantDelay(), random: new FixedRandom(), logger });
    const recheck = new RecheckOpenMarkets({ trading: fake, settings, quote, logger });
    fake.failMarket(ALL[10] ?? "", "unavailable");
    fake.failMarket(ALL[105] ?? "", "contract");
    const summary = await run(recheck);
    expect(summary).toEqual(summaryOf({ markets: 120, quoted: 118, failed: 2 }));
    // Every other market was quoted, those after the failures (page 1 and page 2, other tenants) included.
    expect(fake.book(ALL[11] ?? "")?.offers).toHaveLength(6);
    expect(fake.book(ALL[119] ?? "")?.offers).toHaveLength(6);
    expect(fake.book(ALL[10] ?? "")?.offers).toEqual([]);
    expect(fake.book(ALL[105] ?? "")?.offers).toEqual([]);

    fake.failMarket(ALL[10] ?? "", null);
    fake.failMarket(ALL[105] ?? "", null);
    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, quoted: 2, unchanged: 118 }));
  });

  it("rethrows an error that is neither of trading's failures, and does not move the resume position", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[5] ?? "", new Error("bug"));
    await expect(run(recheck)).rejects.toThrow("bug");
    quote.clear();
    quote.script.clear();
    await run(recheck);
    expect(quote.order).toEqual(ALL);
  });
});

describe("RecheckOpenMarkets: a run that ends early and the next one", () => {
  const serviceDown = (): TradingUnavailable => new TradingUnavailable("the circuit is open", { scope: "service" });

  it("ends the run on TradingUnavailable of the whole service, and the next run starts after that market and wraps around", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[30] ?? "", serviceDown());
    const first = await run(recheck);
    expect(first).toEqual(summaryOf({ completed: false, markets: 30, unchanged: 30, failure: "TradingUnavailable: the circuit is open" }));
    expect(quote.order).toEqual(ALL.slice(0, 31));
    expect(listCalls(fake)).toBe(1);

    quote.clear();
    quote.script.clear();
    const second = await run(recheck);
    expect(second).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    // After the failed market to the last page, then the first page again up to and including the failed market.
    expect(quote.order).toEqual([...ALL.slice(31), ...ALL.slice(0, 31)]);
    expect(listCalls(fake)).toBe(1 + 2 + 1);

    quote.clear();
    await run(recheck);
    expect(quote.order).toEqual(ALL);
  });

  it("resumes on the second page: skips the first page, quotes the rest, then lists from the start up to the failure", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[110] ?? "", serviceDown());
    await run(recheck);
    expect(quote.order).toEqual(ALL.slice(0, 111));
    const before = listCalls(fake);

    quote.clear();
    quote.script.clear();
    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    expect(quote.order).toEqual([...ALL.slice(111), ...ALL.slice(0, 111)]);
    expect(listCalls(fake) - before).toBe(4);
  });

  it("stops listing the wrapped pass as soon as it reaches the resume position", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[49] ?? "", serviceDown());
    await run(recheck);
    const before = listCalls(fake);
    quote.clear();
    quote.script.clear();
    await run(recheck);
    expect(quote.order).toEqual([...ALL.slice(50), ...ALL.slice(0, 50)]);
    // Both pages for the markets from 50 on, then the first page only: position 50 is on it.
    expect(listCalls(fake) - before).toBe(3);
  });

  it("goes on from the failed market again when the next run fails there once more, without ever starving the markets in front", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[30] ?? "", serviceDown());
    await run(recheck);
    quote.clear();
    // The second run starts after market 30, wraps and fails at market 30 again, having quoted everything else.
    const second = await run(recheck);
    expect(second).toEqual(summaryOf({ completed: false, markets: 119, unchanged: 119, failure: "TradingUnavailable: the circuit is open" }));
    expect(quote.order).toEqual([...ALL.slice(31), ...ALL.slice(0, 31)]);
    // A failure in front of the resume position moves it back, so the next run starts after that market.
    quote.script.clear();
    quote.script.set(ALL[10] ?? "", serviceDown());
    quote.clear();
    await run(recheck);
    expect(quote.order).toEqual([...ALL.slice(31), ...ALL.slice(0, 11)]);
    quote.clear();
    quote.script.clear();
    await run(recheck);
    expect(quote.order).toEqual([...ALL.slice(11), ...ALL.slice(0, 11)]);
  });

  it("ends the run when a list call fails, and the next run continues at the page that failed", async () => {
    const { fake, ALL } = listOf120();
    const flaky = new FlakyList(fake);
    const { quote, recheck } = stubbed(flaky);
    flaky.failOnListCall = 2;
    const first = await run(recheck);
    expect(first).toEqual(summaryOf({ completed: false, markets: 100, unchanged: 100, failure: "TradingUnavailable: the list call failed" }));
    expect(quote.order).toEqual(ALL.slice(0, 100));

    quote.clear();
    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    expect(quote.order).toEqual([...ALL.slice(100), ...ALL.slice(0, 100)]);
    expect(flaky.listCalls).toBe(2 + 3);
  });

  it("ends the run when the first list call fails, whatever the error is, and resumes from the start", async () => {
    const { fake, ALL } = listOf120();
    const flaky = new FlakyList(fake);
    const { quote, recheck, logger } = stubbed(flaky);
    flaky.failOnListCall = 1;
    flaky.failure = new Error("boom");
    expect(await run(recheck)).toEqual(summaryOf({ completed: false, failure: "Error: boom" }));
    expect(quote.inputs).toEqual([]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", message: "Recheck ended early", fields: { failure: "Error: boom", resumeAt: 0 } });

    expect(await run(recheck)).toEqual(summaryOf({ markets: 120, unchanged: 120 }));
    expect(quote.order).toEqual(ALL);
  });

  it("describes a thrown value that is not an Error without naming it", async () => {
    const { fake } = listOf120();
    const flaky = new FlakyList(fake);
    const { recheck } = stubbed(flaky);
    flaky.failOnListCall = 1;
    flaky.failure = "not an error" as unknown as Error;
    expect((await run(recheck)).failure).toBe("a value that is not an Error was thrown");
  });

  it("quotes only the markets that are left when the list shrank below the resume position, and completes", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[110] ?? "", serviceDown());
    await run(recheck);
    for (const id of ALL.slice(50)) fake.setStatus(id, "closed");
    quote.clear();
    quote.script.clear();
    expect(await run(recheck)).toEqual(summaryOf({ markets: 50, unchanged: 50 }));
    expect(quote.order).toEqual(ALL.slice(0, 50));
    quote.clear();
    await run(recheck);
    expect(quote.order).toEqual(ALL.slice(0, 50));
  });
});

describe("RecheckOpenMarkets: shutdown", () => {
  it("ends the run between markets when shouldStop says so, without moving the resume position", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    const summary = await run(recheck, { shouldStop: () => quote.inputs.length >= 5 });
    expect(summary).toEqual(summaryOf({ completed: false, markets: 5, unchanged: 5, failure: "stopped" }));
    expect(quote.order).toEqual(ALL.slice(0, 5));

    quote.clear();
    await run(recheck);
    expect(quote.order).toEqual(ALL);
  });

  it("keeps the position a failure of trading set when a later run is stopped", async () => {
    const { fake, ALL } = listOf120();
    const { quote, recheck } = stubbed(fake);
    quote.script.set(ALL[30] ?? "", new TradingUnavailable("down", { scope: "service" }));
    await run(recheck);
    quote.clear();
    quote.script.clear();
    await run(recheck, { shouldStop: () => quote.inputs.length >= 5 });
    expect(quote.order).toEqual(ALL.slice(31, 36));
    quote.clear();
    await run(recheck);
    expect(quote.order).toEqual([...ALL.slice(31), ...ALL.slice(0, 31)]);
  });

  it("stops before listing when shouldStop is already true", async () => {
    const { fake } = listOf120();
    const { quote, recheck } = stubbed(fake);
    expect(await run(recheck, { shouldStop: () => true })).toEqual(summaryOf({ completed: false, failure: "stopped" }));
    expect(fake.calls).toEqual([]);
    expect(quote.inputs).toEqual([]);
  });
});

describe("RecheckOpenMarkets with the real quote run", () => {
  function wired() {
    const clock = new TestClock();
    const fake = new FakeTradingClient({ clock });
    const ids: string[] = [];
    const tenants = [TENANT_A, TENANT_B, TENANT_C];
    for (let n = 0; n < 6; n += 1) {
      ids.push(marketId(n));
      fake.addMarket(bookOf({ marketId: marketId(n), tenantId: tenants[n % 3] ?? TENANT_A, startingPriceMicro: 300_000 + (n % 5) * 100_000 }).market);
    }
    const settings = new TestSettings();
    const logger = new RecordingLogger();
    const quote = new QuoteMarket({ trading: fake, settings, clock, delay: new InstantDelay(), random: new FixedRandom(), logger });
    return { clock, fake, ids, settings, logger, recheck: new RecheckOpenMarkets({ trading: fake, settings, quote, logger }) };
  }

  it("quotes every open market of every tenant on the first run and leaves them alone on the second", async () => {
    const { fake, ids, recheck } = wired();
    expect(await run(recheck)).toEqual(summaryOf({ markets: 6, quoted: 6 }));
    for (const id of ids) expect(fake.book(id)?.offers.length).toBeGreaterThan(0);
    expect(await run(recheck)).toEqual(summaryOf({ markets: 6, unchanged: 6 }));
    expect(fake.calls.filter((call) => call.method === "replace")).toHaveLength(6);
  });

  it("quotes a market that was listed for the first time, and one whose offers are on an older sequence", async () => {
    const { fake, ids, recheck } = wired();
    await run(recheck);
    fake.trade(ids[2] ?? "", "YES", credits(10));
    fake.addMarket(bookOf({ marketId: marketId(99), tenantId: TENANT_B }).market);
    expect(await run(recheck)).toEqual(summaryOf({ markets: 7, quoted: 2, unchanged: 5 }));
    expect(fake.book(ids[2] ?? "")?.offersPricedOnSequence).toBe(1);
    expect(fake.book(marketId(99))?.offers).toHaveLength(6);
  });

  it("does not list a closed market, counts a market that is not ready and requotes everything after a settings change", async () => {
    const { fake, ids, recheck, settings } = wired();
    fake.setStatus(ids[0] ?? "", "closed");
    fake.addMarket(bookOf({ marketId: marketId(98), status: "open", startingPriceMicro: null }).market);
    expect(await run(recheck)).toEqual(summaryOf({ markets: 6, quoted: 5, notReady: 1 }));
    settings.settings = { ...settings.settings, spreadMicro: 40_000 };
    expect(await run(recheck)).toEqual(summaryOf({ markets: 6, quoted: 5, notReady: 1 }));
  });

  it("ends the run on a service failure and the next run quotes the markets it had not reached", async () => {
    const { fake, ids, recheck } = wired();
    fake.failNext("unavailable_service", { method: "book", marketId: ids[4] ?? "" });
    const first = await run(recheck);
    expect(first).toEqual(summaryOf({ completed: false, markets: 3, quoted: 3, failure: expect.stringContaining("TradingUnavailable") as string }));
    const second = await run(recheck);
    expect(second).toEqual(summaryOf({ markets: 6, quoted: 3, unchanged: 3 }));
    for (const id of ids) expect(fake.book(id)?.offers.length).toBeGreaterThan(0);
  });
});

describe("RecheckOpenMarkets: where the next run starts after trading ended one", () => {
  const unavailableAsService = (sent?: boolean) => new TradingUnavailable("the circuit to trading is open", { scope: "service", ...(sent === undefined ? {} : { sent }) });

  it("starts at the market itself when its call never reached trading (sent false), and after it when a request went out or that is not known", async () => {
    for (const [sent, firstOfNextRun] of [
      [false, 7],
      [true, 8],
      [undefined, 8],
    ] as const) {
      const { fake, ALL } = listOf120();
      const { quote, recheck } = stubbed(fake);
      quote.script.set(ALL[7] ?? "", unavailableAsService(sent));
      const first = await run(recheck);
      expect(first).toMatchObject({ completed: false, markets: 7 });
      expect(quote.order).toEqual(ALL.slice(0, 8));

      quote.clear();
      quote.script.clear();
      await run(recheck);
      // The next run goes on from its resume position to the end, then takes the markets in front of it.
      expect(quote.order[0], `sent ${String(sent)}`).toBe(ALL[firstOfNextRun]);
      expect(new Set(quote.order)).toEqual(new Set(ALL));
    }
  });
});

describe("RecheckOpenMarkets over the real client and its circuit breaker", () => {
  const MARKETS = 20;
  const FAILING = 10;
  const ids = Array.from({ length: MARKETS }, (_, n) => marketId(n));
  const failingId = ids[FAILING] ?? "";
  const marketJson = (id: string) => ({
    marketId: id,
    tenantId: TENANT_A,
    status: "open",
    version: 2,
    closeTime: "2026-12-01T10:00:00.000Z",
    startingPriceMicro: 500_000,
    fundingMicro: 5_000_000_000,
    tradeSequence: 4,
  });
  const bookJson = (id: string) => ({
    market: marketJson(id),
    holdings: { balanceMicro: 0, yesMicro: 5_000_000_000, noMicro: 5_000_000_000 },
    offers: [],
    tradeSequence: 4,
    offersPricedOnSequence: null,
    maxOffersPerSide: 10,
  });
  const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Trading as a fetch stub: the list, every bot-book (503 for the failing markets) and every replacement. */
  function wired(failing: readonly string[], policy: Partial<TradingPolicyConfig>) {
    const answered = new Set<string>();
    const fetchStub = ((input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const book = /\/markets\/([^/]+)\/(bot-book|bot-orders)$/.exec(url.pathname);
      if (book === null) return Promise.resolve(jsonResponse({ items: ids.map(marketJson), nextCursor: null }));
      const id = decodeURIComponent(book[1] ?? "");
      if (failing.includes(id)) return Promise.resolve(new Response("unavailable", { status: 503 }));
      if (init.method === "GET") answered.add(id);
      return Promise.resolve(jsonResponse(bookJson(id)));
    }) as typeof fetch;
    const logger = new RecordingLogger();
    const trading = new TradingHttpClient({
      baseUrl: "http://trading.test:8081",
      tokens: { token: () => Promise.resolve("service-token") },
      policy: { timeoutMs: 500, retries: 2, circuitFailures: 5, circuitHalfOpenMs: 30, ...policy },
      logger,
      fetch: fetchStub,
      retryInitialDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    const settings = new TestSettings();
    const quote = new QuoteMarket({ trading, settings, clock: new TestClock(), delay: new InstantDelay(), random: new FixedRandom(), logger });
    return { answered, recheck: new RecheckOpenMarkets({ trading, settings, quote, logger }) };
  }

  it("checks the market behind one that always fails within two runs when its failures open the circuit (circuitFailures = retries + 1)", async () => {
    const { answered, recheck } = wired([failingId], { retries: 2, circuitFailures: 3 });
    const healthy = ids.filter((id) => id !== failingId);

    const first = await run(recheck);
    // The failing market's third attempt opens the circuit; the market behind it is then rejected without a request.
    expect(first).toMatchObject({ completed: false, failed: 1, failure: expect.stringContaining("circuit") as string });
    expect(answered.has(ids[FAILING + 1] ?? "")).toBe(false);

    await sleep(80);
    await run(recheck);
    // The market the open circuit turned away is tried first by the next run, and the markets in front of the failure follow.
    for (const id of healthy) expect(answered.has(id), `market ${ids.indexOf(id)}`).toBe(true);
  });

  it("reaches every healthy market within three runs with the default circuit settings, too", async () => {
    const { answered, recheck } = wired([failingId], {});
    for (let round = 0; round < 3; round += 1) {
      await run(recheck);
      await sleep(80);
    }
    for (const id of ids.filter((candidate) => candidate !== failingId)) expect(answered.has(id), `market ${ids.indexOf(id)}`).toBe(true);
  });
});
