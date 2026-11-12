import { describe, expect, it } from "vitest";
import { FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE } from "../../src/domain/consumed.js";
import type { MarketNotice, MarketNoticeKind } from "../../src/domain/consumed.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import { QuoteMarket } from "../../src/usecases/quote-market.js";
import { ReactToMarketEvent } from "../../src/usecases/react-to-market-event.js";
import { EVENT_BEFORE_START_MARGIN_MS } from "../../src/usecases/support.js";
import type { QuoteMarketInput, QuoteMarketUseCase, QuoteOutcome } from "../../src/usecases/use-cases.js";
import { EVENT_1, FixedRandom, InstantDelay, MARKET_1, RecordingLogger, TENANT_A, TestClock, TestSettings, bookOf, credits } from "../support/fakes.js";

const STARTED_AT = new Date("2026-11-01T10:00:00.000Z");
const TYPES: Record<MarketNoticeKind, string> = {
  market_opened: MARKET_OPENED_TYPE,
  market_closed: MARKET_CLOSED_TYPE,
  market_resolved: MARKET_RESOLVED_TYPE,
  trade_executed: TRADE_EXECUTED_TYPE,
};

function noticeOf(kind: MarketNoticeKind, overrides: Partial<MarketNotice> = {}): MarketNotice {
  return {
    kind,
    eventId: EVENT_1,
    eventType: TYPES[kind],
    tenantId: TENANT_A,
    marketId: MARKET_1,
    tradeSequence: kind === "trade_executed" ? 7 : null,
    correlationId: "corr-9",
    time: new Date(STARTED_AT.getTime() + 1000),
    ...overrides,
  };
}

/** Records the quote runs it is asked for and answers a fixed outcome or a failure. */
class RecordingQuote implements QuoteMarketUseCase {
  readonly inputs: QuoteMarketInput[] = [];
  constructor(private readonly answer: QuoteOutcome | Error = { kind: "unchanged", tradeSequence: 3 }) {}
  execute(input: QuoteMarketInput): Promise<QuoteOutcome> {
    this.inputs.push(input);
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }
}

function setup(answer?: QuoteOutcome | Error) {
  const quote = new RecordingQuote(answer);
  const logger = new RecordingLogger();
  return { quote, logger, react: new ReactToMarketEvent(quote, logger, { startedAt: STARTED_AT }) };
}

describe("ReactToMarketEvent: events that start a quote run", () => {
  it("quotes the market of a MarketOpened event, with the notice's tenant and correlation id, and returns the outcome", async () => {
    const { quote, react } = setup({ kind: "quoted", tradeSequence: 0, offers: 6, attempts: 1 });
    const outcome = await react.execute(noticeOf("market_opened"));
    expect(outcome).toEqual({ kind: "quoted", tradeSequence: 0, offers: 6, attempts: 1 });
    expect(quote.inputs).toEqual([{ marketId: MARKET_1, trigger: "market_opened", tenantId: TENANT_A, knownSequence: null, correlationId: "corr-9" }]);
  });

  it("quotes the market of a TradeExecuted event and passes the event's trade sequence on for the logs", async () => {
    const { quote, react } = setup();
    expect(await react.execute(noticeOf("trade_executed"))).toEqual({ kind: "unchanged", tradeSequence: 3 });
    expect(quote.inputs).toEqual([{ marketId: MARKET_1, trigger: "trade_executed", tenantId: TENANT_A, knownSequence: 7, correlationId: "corr-9" }]);
  });

  it("uses the event id as the correlation id when the event carries none", async () => {
    const { quote, react } = setup();
    await react.execute(noticeOf("trade_executed", { correlationId: null }));
    expect(quote.inputs[0]?.correlationId).toBe(EVENT_1);
  });

  it("passes the failures of the quote run on, so the consumer can nak the message", async () => {
    for (const failure of [new TradingUnavailable("down"), new TradingContractViolation("odd")]) {
      const { react } = setup(failure);
      await expect(react.execute(noticeOf("trade_executed"))).rejects.toBe(failure);
    }
  });
});

describe("ReactToMarketEvent: events that need no call", () => {
  it.each([["market_closed"], ["market_resolved"]] as const)("makes no call for a %s event and says so in the log", async (kind) => {
    const { quote, logger, react } = setup();
    expect(await react.execute(noticeOf(kind))).toEqual({ kind: "stop_notice", event: kind });
    expect(quote.inputs).toEqual([]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { marketId: MARKET_1, tenantId: TENANT_A, eventId: EVENT_1, eventType: TYPES[kind], correlationId: "corr-9" } });
  });

  it("does not skip a closing event that is older than the process start", async () => {
    const { react } = setup();
    const old = new Date(STARTED_AT.getTime() - 24 * 60 * 60 * 1000);
    expect(await react.execute(noticeOf("market_closed", { time: old }))).toEqual({ kind: "stop_notice", event: "market_closed" });
  });
});

describe("ReactToMarketEvent: the backlog of a restarted consumer", () => {
  it.each([["market_opened"], ["trade_executed"]] as const)("skips a %s event older than the start by more than the margin, without a call", async (kind) => {
    const { quote, logger, react } = setup();
    const outcome = await react.execute(noticeOf(kind, { time: new Date(STARTED_AT.getTime() - EVENT_BEFORE_START_MARGIN_MS - 1) }));
    expect(outcome).toEqual({ kind: "skipped", reason: "before_start" });
    expect(quote.inputs).toEqual([]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "debug", fields: { marketId: MARKET_1, eventId: EVENT_1 } });
  });

  it.each([["market_opened"], ["trade_executed"]] as const)("quotes a %s event inside the margin, one at the margin, one after the start, and one without a time", async (kind) => {
    const { quote, react } = setup();
    const times = [new Date(STARTED_AT.getTime() - EVENT_BEFORE_START_MARGIN_MS + 1), new Date(STARTED_AT.getTime() - EVENT_BEFORE_START_MARGIN_MS), STARTED_AT, null];
    for (const time of times) expect((await react.execute(noticeOf(kind, { time }))).kind).toBe("unchanged");
    expect(quote.inputs).toHaveLength(4);
  });
});

describe("ReactToMarketEvent with the real quote run", () => {
  function wired() {
    const clock = new TestClock();
    const fake = new FakeTradingClient({ clock });
    fake.addMarket(bookOf().market);
    const logger = new RecordingLogger();
    const quote = new QuoteMarket({ trading: fake, settings: new TestSettings(), clock, delay: new InstantDelay(), random: new FixedRandom(), logger });
    return { fake, react: new ReactToMarketEvent(quote, logger, { startedAt: clock.now() }) };
  }

  it("quotes on MarketOpened, requotes on a TradeExecuted after a trade and leaves an unchanged book alone", async () => {
    const { fake, react } = wired();
    expect(await react.execute(noticeOf("market_opened", { time: new Date("2026-11-01T10:00:00.000Z") }))).toMatchObject({ kind: "quoted", tradeSequence: 0 });
    expect(await react.execute(noticeOf("trade_executed", { tradeSequence: 0 }))).toEqual({ kind: "unchanged", tradeSequence: 0 });
    fake.trade(MARKET_1, "YES", credits(10));
    expect(await react.execute(noticeOf("trade_executed", { tradeSequence: 1 }))).toMatchObject({ kind: "quoted", tradeSequence: 1 });
    // A duplicate and a late event cost one read each and change nothing.
    expect(await react.execute(noticeOf("trade_executed", { tradeSequence: 1 }))).toEqual({ kind: "unchanged", tradeSequence: 1 });
    expect(await react.execute(noticeOf("trade_executed", { tradeSequence: 0 }))).toEqual({ kind: "unchanged", tradeSequence: 1 });
    expect(fake.calls.map((call) => call.method)).toEqual(["book", "replace", "book", "book", "replace", "book", "book"]);
  });

  it("makes no call for a closing event", async () => {
    const { fake, react } = wired();
    expect(await react.execute(noticeOf("market_resolved"))).toEqual({ kind: "stop_notice", event: "market_resolved" });
    expect(fake.calls).toEqual([]);
  });

  it("reports a market that is not ready, which the consumer naks", async () => {
    const { fake, react } = wired();
    fake.addMarket(bookOf({ status: "funded", startingPriceMicro: null }).market);
    expect(await react.execute(noticeOf("market_opened"))).toEqual({ kind: "not_ready", reason: "no_starting_price" });
  });
});
