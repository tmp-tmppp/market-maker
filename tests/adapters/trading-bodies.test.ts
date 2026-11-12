import { describe, expect, it } from "vitest";
import { PROBLEM_DETAIL_MAX_LENGTH, parseBotBook, parseBotMarket, parseOpenMarketsPage, problemOf } from "../../src/adapters/trading/trading-bodies.js";
import { TradingContractViolation } from "../../src/usecases/errors.js";
import { MARKET_1, MARKET_2, TENANT_A, TENANT_B } from "../support/fakes.js";

// The strict readers of trading's answers: what they accept, what they turn into domain values, and what they refuse
// without ever repeating the offending value.

const LEAK = "LEAK-the-value-must-not-appear";

const market = () => ({
  marketId: MARKET_1,
  tenantId: TENANT_A,
  status: "open",
  version: 3,
  closeTime: "2026-12-01T10:00:00.000Z",
  startingPriceMicro: 600_000,
  fundingMicro: 5_000_000_000,
  tradeSequence: 7,
});

const book = () => ({
  market: market(),
  holdings: { balanceMicro: 1_000_000, yesMicro: 2_000_000_000, noMicro: 3_000_000_000 },
  offers: [
    { side: "YES", priceMicro: 610_000, sharesMicro: 200_000_000 },
    { side: "NO", priceMicro: 410_000, sharesMicro: 300_000_000 },
  ],
  tradeSequence: 7,
  offersPricedOnSequence: 6,
  maxOffersPerSide: 10,
});

/** A copy of `value` with the field at `path` (dots and [n]) set; `undefined` removes it. */
function mutated<T>(value: T, path: string, to: unknown): T {
  const copy = structuredClone(value) as Record<string, unknown>;
  const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  const last = keys.pop() ?? "";
  let node: Record<string, unknown> = copy;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (to === undefined) delete node[last];
  else node[last] = to;
  return copy as T;
}

function violationOf(read: () => unknown): TradingContractViolation {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(TradingContractViolation);
    return error as TradingContractViolation;
  }
  throw new Error("The body was accepted");
}

describe("parseBotMarket", () => {
  it("returns the domain value: the close time as a Date, ids in lower case", () => {
    const parsed = parseBotMarket({ ...market(), marketId: MARKET_1.toUpperCase(), tenantId: TENANT_A.toUpperCase() });
    expect(parsed).toEqual({
      marketId: MARKET_1,
      tenantId: TENANT_A,
      status: "open",
      version: 3,
      closeTime: new Date("2026-12-01T10:00:00.000Z"),
      startingPriceMicro: 600_000,
      fundingMicro: 5_000_000_000,
      tradeSequence: 7,
    });
  });

  it.each(["funded", "open", "closed", "resolved"])("accepts the status %s", (status) => {
    expect(parseBotMarket({ ...market(), status }).status).toBe(status);
  });

  it("accepts null for the close time, the starting price and the funding, and an offset in the close time", () => {
    const parsed = parseBotMarket({ ...market(), closeTime: null, startingPriceMicro: null, fundingMicro: null });
    expect(parsed).toMatchObject({ closeTime: null, startingPriceMicro: null, fundingMicro: null });
    expect(parseBotMarket({ ...market(), closeTime: "2026-12-01T12:00:00+02:00" }).closeTime).toEqual(new Date("2026-12-01T10:00:00.000Z"));
  });

  it("ignores fields the contract does not know (a new optional field must not stop the bot)", () => {
    expect(parseBotMarket({ ...market(), somethingNew: { a: 1 } })).toEqual(parseBotMarket(market()));
  });

  it.each([
    ["marketId", undefined, "marketId is missing"],
    ["marketId", LEAK, "marketId is not a UUID"],
    ["tenantId", 5, "tenantId is not a UUID"],
    ["status", LEAK, "status is not one of funded, open, closed, resolved"],
    ["status", undefined, "status is missing"],
    ["version", -1, "version is outside"],
    ["version", 1.5, "version is not a safe integer"],
    ["version", LEAK, "version is not a safe integer"],
    ["closeTime", LEAK, "closeTime is not an RFC 3339 date-time"],
    ["closeTime", "2026-12-01T10:00:00", "closeTime is not an RFC 3339 date-time"],
    ["closeTime", "2026-13-01T10:00:00Z", "closeTime is not a real date-time"],
    ["closeTime", undefined, "closeTime is missing"],
    ["startingPriceMicro", 5_000, "startingPriceMicro is not a grid price"],
    ["startingPriceMicro", 615_000, "startingPriceMicro is not a grid price"],
    ["startingPriceMicro", 1_000_000, "startingPriceMicro is not a grid price"],
    ["startingPriceMicro", LEAK, "startingPriceMicro is not a grid price"],
    ["startingPriceMicro", undefined, "startingPriceMicro is missing"],
    ["fundingMicro", 0, "fundingMicro is outside"],
    ["fundingMicro", 2 ** 53, "fundingMicro is not a safe integer"],
    ["fundingMicro", 1.5, "fundingMicro is not a safe integer"],
    ["tradeSequence", -1, "tradeSequence is outside"],
    ["tradeSequence", null, "tradeSequence is not a safe integer"],
  ])("refuses %s = %s: %s, without repeating the value", (field, to, message) => {
    const failure = violationOf(() => parseBotMarket(mutated(market(), field, to)));
    expect(failure.message).toContain(message);
    expect(failure.message).not.toContain(LEAK);
  });

  it.each([[null], [[]], ["a string"], [7]])("refuses a body that is not an object: %j", (body) => {
    expect(violationOf(() => parseBotMarket(body)).message).toBe("the body is not a JSON object");
  });
});

describe("parseBotBook", () => {
  it("returns the domain value of a full book", () => {
    const parsed = parseBotBook(book());
    expect(parsed).toEqual({
      market: parseBotMarket(market()),
      holdings: { balanceMicro: 1_000_000, yesMicro: 2_000_000_000, noMicro: 3_000_000_000 },
      offers: [
        { side: "YES", priceMicro: 610_000, sharesMicro: 200_000_000 },
        { side: "NO", priceMicro: 410_000, sharesMicro: 300_000_000 },
      ],
      tradeSequence: 7,
      offersPricedOnSequence: 6,
      maxOffersPerSide: 10,
    });
  });

  it("accepts no offers with offersPricedOnSequence null, and the bounds of maxOffersPerSide and of a size", () => {
    expect(parseBotBook({ ...book(), offers: [], offersPricedOnSequence: null })).toMatchObject({ offers: [], offersPricedOnSequence: null });
    expect(parseBotBook({ ...book(), maxOffersPerSide: 1 }).maxOffersPerSide).toBe(1);
    expect(parseBotBook({ ...book(), maxOffersPerSide: 50 }).maxOffersPerSide).toBe(50);
    const largest = mutated(book(), "offers[0].sharesMicro", Number.MAX_SAFE_INTEGER);
    expect(parseBotBook(largest).offers[0]?.sharesMicro).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps the offers in the order they came, one object per offer, without extra fields", () => {
    const withExtra = mutated(book(), "offers[0]", { side: "YES", priceMicro: 610_000, sharesMicro: 5, note: "x" });
    expect(parseBotBook(withExtra).offers[0]).toEqual({ side: "YES", priceMicro: 610_000, sharesMicro: 5 });
  });

  it.each([
    ["market", undefined, "market is missing"],
    ["market", null, "market is not a JSON object"],
    ["market.status", LEAK, "market.status is not one of"],
    ["market.tradeSequence", -3, "market.tradeSequence is outside"],
    ["holdings", undefined, "holdings is missing"],
    ["holdings.balanceMicro", -1, "holdings.balanceMicro is outside"],
    ["holdings.yesMicro", 1.5, "holdings.yesMicro is not a safe integer"],
    ["holdings.noMicro", 2 ** 53, "holdings.noMicro is not a safe integer"],
    ["holdings.noMicro", undefined, "holdings.noMicro is missing"],
    ["offers", LEAK, "offers is not an array"],
    ["offers", undefined, "offers is missing"],
    ["offers[1].side", LEAK, "offers[1].side is not YES or NO"],
    ["offers[0].priceMicro", 615_000, "offers[0].priceMicro is not a grid price"],
    ["offers[0].priceMicro", 0, "offers[0].priceMicro is not a grid price"],
    ["offers[1].sharesMicro", 0, "offers[1].sharesMicro is outside"],
    ["offers[1].sharesMicro", 2 ** 53, "offers[1].sharesMicro is not a safe integer"],
    ["offers[1].sharesMicro", 2.5, "offers[1].sharesMicro is not a safe integer"],
    ["offers[1].sharesMicro", undefined, "offers[1].sharesMicro is missing"],
    ["offers[0]", LEAK, "offers[0] is not a JSON object"],
    ["tradeSequence", -1, "tradeSequence is outside"],
    ["tradeSequence", undefined, "tradeSequence is missing"],
    ["offersPricedOnSequence", undefined, "offersPricedOnSequence is missing"],
    ["offersPricedOnSequence", -1, "offersPricedOnSequence is outside"],
    ["offersPricedOnSequence", LEAK, "offersPricedOnSequence is not a safe integer"],
    ["maxOffersPerSide", undefined, "maxOffersPerSide is missing"],
    ["maxOffersPerSide", 0, "maxOffersPerSide is outside 1..50"],
    ["maxOffersPerSide", 51, "maxOffersPerSide is outside 1..50"],
    ["maxOffersPerSide", 2.5, "maxOffersPerSide is not a safe integer"],
    ["maxOffersPerSide", "10", "maxOffersPerSide is not a safe integer"],
    ["maxOffersPerSide", null, "maxOffersPerSide is not a safe integer"],
  ])("refuses %s = %s: %s, without repeating the value", (field, to, message) => {
    const failure = violationOf(() => parseBotBook(mutated(book(), field, to)));
    expect(failure.message).toContain(message);
    expect(failure.message).not.toContain(LEAK);
  });

  it("refuses a body that is not an object", () => {
    expect(violationOf(() => parseBotBook([book()])).message).toBe("the body is not a JSON object");
  });
});

describe("parseOpenMarketsPage", () => {
  const page = () => ({
    items: [market(), { ...market(), marketId: MARKET_2, tenantId: TENANT_B, status: "funded", startingPriceMicro: null }],
    nextCursor: "opaque-cursor==",
  });

  it("returns the markets and the cursor", () => {
    const parsed = parseOpenMarketsPage(page());
    expect(parsed.items.map((item) => [item.marketId, item.tenantId, item.status])).toEqual([
      [MARKET_1, TENANT_A, "open"],
      [MARKET_2, TENANT_B, "funded"],
    ]);
    expect(parsed.nextCursor).toBe("opaque-cursor==");
  });

  it("accepts an empty last page", () => {
    expect(parseOpenMarketsPage({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ["items", undefined, "items is missing"],
    ["items", LEAK, "items is not an array"],
    ["items[1].status", LEAK, "items[1].status is not one of"],
    ["items[0]", null, "items[0] is not a JSON object"],
    ["items[1].marketId", undefined, "items[1].marketId is missing"],
    ["nextCursor", undefined, "nextCursor is missing"],
    ["nextCursor", "", "nextCursor is not a non-empty string or null"],
    ["nextCursor", 12, "nextCursor is not a non-empty string or null"],
  ])("refuses %s = %s: %s, without repeating the value", (field, to, message) => {
    const failure = violationOf(() => parseOpenMarketsPage(mutated(page(), field, to)));
    expect(failure.message).toContain(message);
    expect(failure.message).not.toContain(LEAK);
  });
});

describe("problemOf", () => {
  it("reads the code, the detail and the trade sequence of a problem body", () => {
    const text = JSON.stringify({ type: "urn:chance:problem:stale-sequence", title: "Conflict", status: 409, detail: "A trade happened", code: "stale_sequence", tradeSequence: 12 });
    expect(problemOf(text)).toEqual({ code: "stale_sequence", detail: "A trade happened", tradeSequence: 12 });
  });

  it("falls back to the title when there is no detail, and to nulls when a part is missing or of another type", () => {
    expect(problemOf(JSON.stringify({ title: "Bad Request", code: "validation_failed" }))).toEqual({ code: "validation_failed", detail: "Bad Request", tradeSequence: null });
    expect(problemOf(JSON.stringify({ code: 5, detail: 7, tradeSequence: "3" }))).toEqual({ code: null, detail: null, tradeSequence: null });
    expect(problemOf(JSON.stringify({ tradeSequence: -1 })).tradeSequence).toBeNull();
    expect(problemOf(JSON.stringify({ tradeSequence: 1.5 })).tradeSequence).toBeNull();
  });

  it("keeps only codes that are lower-case words with underscores", () => {
    expect(problemOf(JSON.stringify({ code: "Not A Code\n" })).code).toBeNull();
    expect(problemOf(JSON.stringify({ code: "market_not_open" })).code).toBe("market_not_open");
  });

  it("cuts a long detail, because it goes into logs", () => {
    const detail = problemOf(JSON.stringify({ detail: "d".repeat(1000) })).detail;
    expect(detail).toHaveLength(PROBLEM_DETAIL_MAX_LENGTH);
  });

  it.each([[""], ["<html>Bad Gateway</html>"], ["[1, 2]"], ["null"], ["7"], [`{"detail":"${"x".repeat(9000)}"}`]])("gives nulls for text that is no problem body: %.30s", (text) => {
    expect(problemOf(text)).toEqual({ code: null, detail: null, tradeSequence: null });
  });
});
