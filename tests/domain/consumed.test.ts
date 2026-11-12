import { describe, expect, it } from "vitest";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE, readMarketNotice } from "../../src/domain/consumed.js";
import { EVENT_1, MARKET_1, TENANT_A } from "../support/fakes.js";

function event(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: "1.0",
    id: EVENT_1.toUpperCase(),
    source: "/chance/markets",
    type,
    subject: `market/${MARKET_1.toUpperCase()}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    causationid: "req-1",
    data: { marketId: MARKET_1 },
    ...overrides,
  };
}

describe("readMarketNotice", () => {
  it("reads the four consumed types from the envelope alone", () => {
    expect(readMarketNotice(event(MARKET_OPENED_TYPE))).toEqual({
      kind: "market_opened",
      eventId: EVENT_1,
      eventType: MARKET_OPENED_TYPE,
      tenantId: TENANT_A,
      marketId: MARKET_1,
      tradeSequence: null,
      correlationId: "corr-1",
      time: new Date("2026-11-01T10:00:00.000Z"),
    });
    expect(readMarketNotice(event(MARKET_CLOSED_TYPE))).toMatchObject({ kind: "market_closed" });
    expect(readMarketNotice(event(MARKET_RESOLVED_TYPE))).toMatchObject({ kind: "market_resolved" });
    expect(readMarketNotice(event(TRADE_EXECUTED_TYPE, { data: { tradeSequence: 7 } }))).toMatchObject({ kind: "trade_executed", tradeSequence: 7 });
  });

  it("reads a sale (TradeExecuted kind sale, UC-08) as any trade: a notice to quote the market again", () => {
    const sale = readMarketNotice(event(TRADE_EXECUTED_TYPE, { data: { marketId: MARKET_1, side: "NO", tradeSequence: 8, kind: "sale" } }));
    const buy = readMarketNotice(event(TRADE_EXECUTED_TYPE, { data: { marketId: MARKET_1, side: "NO", tradeSequence: 8, kind: "buy" } }));
    expect(sale).toEqual(buy);
    expect(sale).toMatchObject({ kind: "trade_executed", marketId: MARKET_1, tradeSequence: 8 });
  });

  it("reads MarketResolved with any outcome, INVALID (UC-16) included: the outcome is never parsed, the event only stops quoting", () => {
    for (const outcome of ["YES", "NO", "INVALID", "SOMETHING_NEW"]) {
      const data = { marketId: MARKET_1, outcome, version: 5, resolvedAt: "2026-11-01T10:00:00.000Z", resolvedBy: "admin-1", creatorId: "admin-1" };
      expect(readMarketNotice(event(MARKET_RESOLVED_TYPE, { data })), outcome).toMatchObject({ kind: "market_resolved", marketId: MARKET_1, tenantId: TENANT_A });
    }
  });

  it("needs no business field of data: a notice without data is still a notice", () => {
    const body = event(MARKET_OPENED_TYPE);
    delete body["data"];
    expect(readMarketNotice(body)).toMatchObject({ kind: "market_opened", marketId: MARKET_1 });
    expect(readMarketNotice(event(TRADE_EXECUTED_TYPE, { data: { tradeSequence: -1 } }))).toMatchObject({ tradeSequence: null });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { correlationid: "" }))).toMatchObject({ correlationId: null });
  });

  it("reads the event time with a zone, and leaves a missing or unusable one null instead of ignoring the event", () => {
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { time: "2026-11-01T12:00:00+02:00" }))).toMatchObject({ time: new Date("2026-11-01T10:00:00.000Z") });
    for (const time of [undefined, "", "2026-11-01", "2026-11-01T10:00:00", "2026-13-45T10:00:00Z", 1_700_000_000]) {
      expect(readMarketNotice(event(MARKET_OPENED_TYPE, { time }))).toMatchObject({ kind: "market_opened", time: null });
    }
  });

  it("ignores what is not a usable event of the four types", () => {
    expect(readMarketNotice("text")).toMatchObject({ kind: "ignored", eventId: null });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { specversion: "0.3" }))).toMatchObject({ kind: "ignored", eventId: EVENT_1 });
    expect(readMarketNotice(event("si.chance.markets.MarketDrafted.v1"))).toMatchObject({ kind: "ignored", reason: expect.stringContaining("Unknown event type") });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { id: "x" }))).toMatchObject({ kind: "ignored", eventId: null });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { tenantid: undefined }))).toMatchObject({ kind: "ignored" });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { subject: "withdrawal/x" }))).toMatchObject({ kind: "ignored" });
    expect(readMarketNotice(event(MARKET_OPENED_TYPE, { subject: undefined }))).toMatchObject({ kind: "ignored" });
  });
});
