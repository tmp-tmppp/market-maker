import { describe, expect, it } from "vitest";
import { DEMO_MARKET_ID, FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import { parseBotBook, parseOpenMarketsPage } from "../../src/adapters/trading/trading-bodies.js";
import type { BotBook, BotMarket } from "../../src/domain/book.js";
import { computeOffers, referencePriceOf } from "../../src/domain/pricing.js";
import type { OpenMarketsPage } from "../../src/usecases/ports.js";
import { botBookErrors, botMarketPageErrors, replaceRequestErrors } from "../support/contracts.js";
import { MARKET_1, MARKET_2, TENANT_A, TENANT_B, TestClock } from "../support/fakes.js";

// Every body the fake trading client hands out (the local mode, and the double of the use-case tests) must be one the
// real client would accept from trading: it passes the strict parsers and validates against trading's own contract copy.
// The dates become ISO strings first, as they are on the wire.

const iso = (market: BotMarket) => ({ ...market, closeTime: market.closeTime === null ? null : market.closeTime.toISOString() });
const bookBody = (book: BotBook) => ({ ...book, market: iso(book.market) });
const pageBody = (page: OpenMarketsPage) => ({ ...page, items: page.items.map(iso) });

const SETTINGS = { spreadMicro: 20_000, levels: 3 };
const context = { correlationId: "fake-bodies" };

function expectBook(book: BotBook | null): BotBook {
  expect(book).not.toBeNull();
  const body = bookBody(book as BotBook);
  expect(botBookErrors(body)).toEqual([]);
  expect(bookBody(parseBotBook(body))).toEqual(body);
  return book as BotBook;
}

function expectPage(page: OpenMarketsPage): OpenMarketsPage {
  const body = pageBody(page);
  expect(botMarketPageErrors(body)).toEqual([]);
  expect(pageBody(parseOpenMarketsPage(body))).toEqual(body);
  return page;
}

describe("the bodies of the fake trading client", () => {
  const clock = new TestClock();

  it("are valid for the demo market of the local mode: its list page and its book before any offer", async () => {
    const fake = FakeTradingClient.withDemoMarket(clock);
    const page = expectPage(await fake.listOpenMarkets({ cursor: null, limit: 100 }, context));
    expect(page.items.map((item) => item.marketId)).toEqual([DEMO_MARKET_ID]);
    const book = expectBook(await fake.getBotBook(DEMO_MARKET_ID, context));
    expect(book.offers).toEqual([]);
    expect(book.offersPricedOnSequence).toBeNull();
  });

  it("are valid after a replacement, after trades and after a requote, and the body of every PUT is valid for trading", async () => {
    const fake = FakeTradingClient.withDemoMarket(clock);
    const first = expectBook(await fake.getBotBook(DEMO_MARKET_ID, context));
    const quote = (book: BotBook) => {
      if (book.market.fundingMicro === null || book.market.startingPriceMicro === null) throw new Error("the demo market is funded");
      const input = { holdings: book.holdings, fundingMicro: book.market.fundingMicro, startingPriceMicro: book.market.startingPriceMicro, maxOffersPerSide: book.maxOffersPerSide };
      return computeOffers(input, SETTINGS);
    };

    const offers = quote(first);
    expect(offers.length).toBeGreaterThan(0);
    expect(replaceRequestErrors({ basedOnSequence: first.tradeSequence, offers })).toEqual([]);
    const replaced = await fake.replaceBotOrders(DEMO_MARKET_ID, { basedOnSequence: first.tradeSequence, offers }, context);
    expect(replaced.kind).toBe("replaced");
    const afterPut = expectBook(fake.book(DEMO_MARKET_ID));
    expect(afterPut.offersPricedOnSequence).toBe(first.tradeSequence);
    if (replaced.kind === "replaced") expect(bookBody(replaced.book)).toEqual(bookBody(afterPut));

    const cheapestYes = afterPut.offers.filter((offer) => offer.side === "YES")[0];
    fake.trade(DEMO_MARKET_ID, "YES", Math.min(1_000_000, cheapestYes?.sharesMicro ?? 1));
    const afterTrade = expectBook(fake.book(DEMO_MARKET_ID));
    expect(afterTrade.tradeSequence).toBe(first.tradeSequence + 1);
    expect(afterTrade.offersPricedOnSequence).toBe(first.tradeSequence);
    // A YES fill never lowers the reference price: the requote below starts from a price that moved the right way.
    const reference = (book: BotBook) => referencePriceOf({ holdings: book.holdings, fundingMicro: 5_000_000_000, startingPriceMicro: 600_000, maxOffersPerSide: book.maxOffersPerSide }) ?? 0;
    expect(reference(afterTrade)).toBeGreaterThanOrEqual(reference(afterPut));

    const requote = quote(afterTrade);
    expect(replaceRequestErrors({ basedOnSequence: afterTrade.tradeSequence, offers: requote })).toEqual([]);
    expect((await fake.replaceBotOrders(DEMO_MARKET_ID, { basedOnSequence: afterTrade.tradeSequence, offers: requote }, context)).kind).toBe("replaced");
    expect(expectBook(fake.book(DEMO_MARKET_ID)).offersPricedOnSequence).toBe(afterTrade.tradeSequence);
  });

  it("are valid for markets of several tenants in every status, and for pages cut by a limit", async () => {
    const fake = new FakeTradingClient({ clock });
    const market = (marketId: string, tenantId: string, status: BotMarket["status"], startingPriceMicro: number | null): BotMarket => ({
      marketId,
      tenantId,
      status,
      version: 3,
      closeTime: status === "open" ? new Date(clock.now().getTime() + 86_400_000) : null,
      startingPriceMicro,
      fundingMicro: 2_000_000_000,
      tradeSequence: 0,
    });
    fake.addMarket(market(MARKET_1, TENANT_A, "open", 500_000));
    fake.addMarket(market(MARKET_2, TENANT_B, "open", 990_000));
    fake.addMarket(market("018f3c1e-7a00-7000-8000-000000000103", TENANT_A, "funded", null));
    fake.addMarket(market("018f3c1e-7a00-7000-8000-000000000104", TENANT_B, "closed", 400_000));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: OpenMarketsPage = expectPage(await fake.listOpenMarkets({ cursor, limit: 1 }, context));
      seen.push(...page.items.map((item) => item.marketId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([MARKET_1, MARKET_2]);

    for (const id of [MARKET_1, MARKET_2, "018f3c1e-7a00-7000-8000-000000000103", "018f3c1e-7a00-7000-8000-000000000104"]) expectBook(await fake.getBotBook(id, context));
  });
});
