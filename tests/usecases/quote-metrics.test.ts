import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import { QUOTE_RUNS_METRIC, QUOTE_RUN_OUTCOMES, REFUSED_PUTS_METRIC, createQuoteMetrics } from "../../src/adapters/metrics/quote-metrics.js";
import type { BotBook } from "../../src/domain/book.js";
import { TradingUnavailable } from "../../src/usecases/errors.js";
import type { OpenMarketsPage, QuoteObserver, ReplaceResult, TradingClient } from "../../src/usecases/ports.js";
import { QuoteMarket } from "../../src/usecases/quote-market.js";
import { STALE_RETRY_ATTEMPTS } from "../../src/usecases/support.js";
import type { QuoteMarketInput, QuoteOutcome } from "../../src/usecases/use-cases.js";
import { FixedRandom, InstantDelay, MARKET_1, MARKET_2, RecordingLogger, TENANT_A, TestClock, TestSettings, bookOf, credits } from "../support/fakes.js";

// The counters of the quote runs (src/adapters/metrics/quote-metrics.ts), driven through the real QuoteMarket: every
// outcome of a run is counted once under its own label, and only a PUT that trading refused counts as a refused PUT.

type Result = QuoteOutcome | { kind: "error" };

async function values(registry: Registry, name: string): Promise<Record<string, number>> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const found: Record<string, number> = {};
  for (const sample of (await metric.get()).values) found[String(sample.labels["outcome"] ?? "")] = sample.value;
  return found;
}

/** Every outcome at 0, then the counts the test expects. */
const runs = (counts: Record<string, number>): Record<string, number> => ({ ...Object.fromEntries(QUOTE_RUN_OUTCOMES.map((outcome) => [outcome, 0])), ...counts });

class ScriptedTrading implements TradingClient {
  puts = 0;
  constructor(
    private readonly book: BotBook,
    private readonly result: ReplaceResult,
  ) {}
  listOpenMarkets(): Promise<OpenMarketsPage> {
    return Promise.reject(new Error("the quote run does not list markets"));
  }
  getBotBook(): Promise<BotBook | null> {
    return Promise.resolve(this.book);
  }
  replaceBotOrders(): Promise<ReplaceResult> {
    this.puts += 1;
    return Promise.resolve(this.result);
  }
}

const input = (overrides: Partial<QuoteMarketInput> = {}): QuoteMarketInput => ({ marketId: MARKET_1, trigger: "trade_executed", tenantId: TENANT_A, knownSequence: null, correlationId: "corr-1", ...overrides });

function fakeSetup(observer?: QuoteObserver) {
  const registry = new Registry();
  const clock = new TestClock();
  const fake = new FakeTradingClient({ clock });
  fake.addMarket(bookOf().market);
  const settings = new TestSettings();
  const logger = new RecordingLogger();
  const quote = new QuoteMarket({ trading: fake, settings, clock, delay: new InstantDelay(), random: new FixedRandom(0.5), logger, observer: observer ?? createQuoteMetrics(registry) });
  return { registry, fake, settings, logger, quote };
}

function scriptedSetup(book: BotBook, result: ReplaceResult, settings = new TestSettings()) {
  const registry = new Registry();
  const trading = new ScriptedTrading(book, result);
  const quote = new QuoteMarket({ trading, settings, clock: new TestClock(), delay: new InstantDelay(), random: new FixedRandom(0.5), logger: new RecordingLogger(), observer: createQuoteMetrics(registry) });
  return { registry, trading, quote };
}

describe("createQuoteMetrics", () => {
  it("registers both counters with every outcome at 0 from the start: nine values, nothing else", async () => {
    const registry = new Registry();
    createQuoteMetrics(registry);
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({}));
    expect([...QUOTE_RUN_OUTCOMES].sort()).toEqual(["contended", "disabled", "error", "not_found", "not_ready", "quoted", "refused", "stopped", "unchanged"]);
    expect(await values(registry, REFUSED_PUTS_METRIC)).toEqual({ "": 0 });
    const text = await registry.metrics();
    expect(text).toContain(`# TYPE ${QUOTE_RUNS_METRIC} counter`);
    expect(text).toContain(`# TYPE ${REFUSED_PUTS_METRIC} counter`);
  });
});

describe("the quote runs, counted by outcome", () => {
  it("counts a quoted run, then an unchanged one", async () => {
    const { registry, quote } = fakeSetup();
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ quoted: 1 }));
    expect(await quote.execute(input())).toMatchObject({ kind: "unchanged" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ quoted: 1, unchanged: 1 }));
    expect(await values(registry, REFUSED_PUTS_METRIC)).toEqual({ "": 0 });
  });

  it("counts a stopped market, an unknown market and a disabled bot", async () => {
    const { registry, fake, settings, quote } = fakeSetup();
    fake.setStatus(MARKET_1, "closed");
    expect(await quote.execute(input())).toMatchObject({ kind: "stopped" });
    expect(await quote.execute(input({ marketId: MARKET_2 }))).toEqual({ kind: "not_found" });
    settings.settings = { ...settings.settings, enabled: false };
    expect(await quote.execute(input())).toEqual({ kind: "disabled" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ stopped: 1, not_found: 1, disabled: 1 }));
  });

  it("counts a market that is not ready (no starting price yet)", async () => {
    const { registry, quote } = scriptedSetup(bookOf({ startingPriceMicro: null }), { kind: "replaced", book: bookOf() });
    expect(await quote.execute(input())).toMatchObject({ kind: "not_ready" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ not_ready: 1 }));
  });

  it("counts a run that gave up after repeated stale answers once, not once per attempt", async () => {
    const { registry, fake, quote } = fakeSetup();
    for (let attempt = 0; attempt < STALE_RETRY_ATTEMPTS; attempt += 1) fake.failNext("stale");
    expect(await quote.execute(input())).toMatchObject({ kind: "contended" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ contended: 1 }));
  });

  it("counts a run that threw as error and throws the same error again", async () => {
    const { registry, fake, quote } = fakeSetup();
    fake.failNext("unavailable");
    await expect(quote.execute(input())).rejects.toBeInstanceOf(TradingUnavailable);
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ error: 1 }));
    // The next run goes on as before.
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ error: 1, quoted: 1 }));
  });

  it("counts the callers that share one waiting run as one run", async () => {
    const results: Result[] = [];
    const { fake, quote } = fakeSetup({ runEnded: (result) => results.push(result) });
    // Run 0 puts offers on the book, so that a trade can fill one of them.
    await quote.execute(input({ correlationId: "run-0" }));
    fake.trade(MARKET_1, "YES", credits(10));
    results.length = 0;

    const first = quote.execute(input({ correlationId: "n-1" }));
    const second = quote.execute(input({ correlationId: "n-2" }));
    const third = quote.execute(input({ correlationId: "n-3" }));
    expect(second).toBe(third);
    await Promise.all([first, second, third]);
    // Two runs for three callers: the first, and the one the second and third share.
    expect(results).toHaveLength(2);
  });
});

describe("the refused PUTs", () => {
  it.each([
    [{ kind: "refused", status: 400, code: "validation_failed", detail: "At most 2 offers per side" }],
    [{ kind: "refused", status: 400, code: "crossed_offers", detail: "crossed" }],
    [{ kind: "refused", status: 409, code: "insufficient_holdings", detail: "cannot back" }],
  ] satisfies Array<[ReplaceResult]>)("counts a PUT that trading refused, under no label: %j", async (result) => {
    const { registry, trading, quote } = scriptedSetup(bookOf(), result);
    expect(await quote.execute(input())).toEqual(result);
    expect(trading.puts).toBe(1);
    expect(await values(registry, REFUSED_PUTS_METRIC)).toEqual({ "": 1 });
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ refused: 1 }));
    // The code and the detail of the refusal are in the log, never in a label: the sample has no label at all.
    const text = await registry.metrics();
    expect(text).toMatch(/^market_maker_refused_puts_total 1$/m);
    expect(text).not.toContain(result.detail);
  });

  it("does not count a list the bot itself refused to send (status 0): that run is refused, but no PUT was made", async () => {
    const settings = new TestSettings();
    settings.settings = { ...settings.settings, spreadMicro: 0 };
    const { registry, trading, quote } = scriptedSetup(bookOf(), { kind: "replaced", book: bookOf() }, settings);
    expect(await quote.execute(input())).toMatchObject({ kind: "refused", status: 0 });
    expect(trading.puts).toBe(0);
    expect(await values(registry, QUOTE_RUNS_METRIC)).toEqual(runs({ refused: 1 }));
    expect(await values(registry, REFUSED_PUTS_METRIC)).toEqual({ "": 0 });
  });
});

describe("an observer that fails", () => {
  it("does not change the outcome of the run, and the failure is logged as a warning", async () => {
    const failing: QuoteObserver = {
      runEnded: () => {
        throw new Error("the observer broke");
      },
    };
    const { quote, fake, logger } = fakeSetup(failing);
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
    fake.failNext("unavailable");
    await expect(quote.execute(input())).rejects.toBeInstanceOf(TradingUnavailable);
    expect(logger.messages("warn")).toEqual(["The quote observer failed; the run is not affected", "The quote observer failed; the run is not affected"]);
  });

  it("is optional: a run without an observer is the same run", async () => {
    const clock = new TestClock();
    const fake = new FakeTradingClient({ clock });
    fake.addMarket(bookOf().market);
    const quote = new QuoteMarket({ trading: fake, settings: new TestSettings(), clock, delay: new InstantDelay(), random: new FixedRandom(0.5), logger: new RecordingLogger() });
    expect(await quote.execute(input())).toMatchObject({ kind: "quoted" });
  });
});
