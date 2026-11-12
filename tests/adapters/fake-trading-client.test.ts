import { describe, expect, it } from "vitest";
import { DEMO_MARKET_ID, DEMO_TENANT_ID, FakeTradingClient } from "../../src/adapters/fake/fake-trading-client.js";
import type { BotMarket, Holdings } from "../../src/domain/book.js";
import { offerViolations } from "../../src/domain/offers.js";
import type { Offer } from "../../src/domain/offers.js";
import { computeOffers } from "../../src/domain/pricing.js";
import type { Side } from "../../src/domain/units.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import type { OpenMarketsPage } from "../../src/usecases/ports.js";
import type { BookOptions } from "../support/fakes.js";
import { MARKET_1, MARKET_2, SeededRandom, TENANT_A, TENANT_B, TestClock, bookOf, credits } from "../support/fakes.js";

const ctx = (correlationId = "corr-1") => ({ correlationId });
const DAY_MS = 24 * 60 * 60 * 1000;

function marketOf(marketId: string, options: BookOptions = {}): BotMarket {
  return bookOf({ marketId, ...options }).market;
}

function setup(maxOffersPerSide?: number) {
  const clock = new TestClock();
  const fake = new FakeTradingClient({ clock, ...(maxOffersPerSide === undefined ? {} : { maxOffersPerSide }) });
  fake.addMarket(marketOf(MARKET_1));
  return { clock, fake };
}

const yes = (priceMicro: number, sharesMicro: number): Offer => ({ side: "YES", priceMicro, sharesMicro });
const no = (priceMicro: number, sharesMicro: number): Offer => ({ side: "NO", priceMicro, sharesMicro });

/** A list every rule accepts on the default market (5000 credits as pairs). */
const GOOD_OFFERS: Offer[] = [yes(510_000, credits(100)), yes(520_000, credits(100)), no(510_000, credits(100))];

async function put(fake: FakeTradingClient, offers: Offer[], marketId = MARKET_1, basedOnSequence = 0) {
  return fake.replaceBotOrders(marketId, { basedOnSequence, offers }, ctx());
}

describe("FakeTradingClient: listOpenMarkets", () => {
  it("lists the open markets of every tenant by tenant id, then market id", async () => {
    const { fake } = setup();
    const ids = ["018f3c1e-7a00-7000-8000-000000000a01", "018f3c1e-7a00-7000-8000-000000000a02", "018f3c1e-7a00-7000-8000-000000000a03"];
    fake.addMarket(marketOf(ids[1] ?? "", { tenantId: TENANT_B }));
    fake.addMarket(marketOf(ids[2] ?? "", { tenantId: TENANT_A }));
    fake.addMarket(marketOf(ids[0] ?? "", { tenantId: TENANT_B, status: "closed" }));
    fake.addMarket(marketOf("018f3c1e-7a00-7000-8000-000000000a04", { tenantId: TENANT_A, status: "funded" }));
    const page = await fake.listOpenMarkets({ cursor: null, limit: 100 }, ctx("list-1"));
    expect(page.items.map((item) => [item.tenantId, item.marketId])).toEqual([
      [TENANT_A, MARKET_1],
      [TENANT_A, ids[2]],
      [TENANT_B, ids[1]],
    ]);
    expect(page.nextCursor).toBeNull();
    expect(fake.calls).toEqual([{ method: "list", marketId: null, correlationId: "list-1" }]);
  });

  it("pages with an opaque cursor that names the last item, and has no next page after the last one", async () => {
    const { fake } = setup();
    for (let index = 2; index <= 5; index += 1) fake.addMarket(marketOf(`018f3c1e-7a00-7000-8000-00000000b00${index}`, { tenantId: index % 2 === 0 ? TENANT_A : TENANT_B }));
    const everyone = await fake.listOpenMarkets({ cursor: null, limit: 100 }, ctx());
    expect(everyone.items).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page: OpenMarketsPage = await fake.listOpenMarkets({ cursor, limit: 2 }, ctx());
      sizes.push(page.items.length);
      seen.push(...page.items.map((item) => item.marketId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(everyone.items.map((item) => item.marketId));

    // Exactly a page of markets: no second page (the cursor of an empty rest would be a wasted call).
    expect((await fake.listOpenMarkets({ cursor: null, limit: 5 }, ctx())).nextCursor).toBeNull();
  });

  it("returns copies, so a caller cannot change the fake's markets", async () => {
    const { fake } = setup();
    const page = await fake.listOpenMarkets({ cursor: null, limit: 10 }, ctx());
    const first = page.items[0];
    if (first === undefined) throw new Error("expected a market");
    first.status = "closed";
    first.closeTime?.setUTCFullYear(1999);
    const again = await fake.listOpenMarkets({ cursor: null, limit: 10 }, ctx());
    expect(again.items[0]?.status).toBe("open");
    expect(again.items[0]?.closeTime?.getUTCFullYear()).toBe(2026);
  });

  it("answers a limit outside 1..500 and a cursor it did not issue as outside its contract", async () => {
    const { fake } = setup();
    for (const limit of [0, 501, 1.5]) await expect(fake.listOpenMarkets({ cursor: null, limit }, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
    await expect(fake.listOpenMarkets({ cursor: "not a cursor", limit: 10 }, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
    const wrongShape = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
    await expect(fake.listOpenMarkets({ cursor: wrongShape, limit: 10 }, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
  });
});

describe("FakeTradingClient: getBotBook and addMarket", () => {
  it("returns null for an unknown market and the book of a known one, with the funding as pairs", async () => {
    const { fake } = setup(7);
    expect(await fake.getBotBook(MARKET_2, ctx())).toBeNull();
    const book = await fake.getBotBook(MARKET_1, ctx("book-1"));
    expect(book).toEqual({
      market: marketOf(MARKET_1),
      holdings: { balanceMicro: 0, yesMicro: credits(5000), noMicro: credits(5000) },
      offers: [],
      tradeSequence: 0,
      offersPricedOnSequence: null,
      maxOffersPerSide: 7,
    });
    expect(fake.book(MARKET_2)).toBeNull();
    expect(fake.calls.map((call) => [call.method, call.marketId, call.correlationId])).toEqual([
      ["book", MARKET_2, "corr-1"],
      ["book", MARKET_1, "book-1"],
    ]);
  });

  it("returns copies of its state and lets addMarket take other holdings or replace a market", async () => {
    const { fake } = setup();
    expect((await put(fake, GOOD_OFFERS)).kind).toBe("replaced");
    const book = fake.book(MARKET_1);
    if (book === null) throw new Error("expected a book");
    book.offers.length = 0;
    book.holdings.yesMicro = 1;
    expect(fake.book(MARKET_1)?.offers).toHaveLength(3);
    expect(fake.book(MARKET_1)?.holdings.yesMicro).toBe(credits(5000));

    const holdings: Holdings = { balanceMicro: credits(10), yesMicro: 0, noMicro: credits(3) };
    fake.addMarket(marketOf(MARKET_1), holdings);
    expect(fake.book(MARKET_1)?.holdings).toEqual(holdings);
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    fake.addMarket(marketOf(MARKET_2, { fundingCredits: null }));
    expect(fake.book(MARKET_2)?.holdings).toEqual({ balanceMicro: 0, yesMicro: 0, noMicro: 0 });
  });
});

describe("FakeTradingClient: replaceBotOrders", () => {
  it("stores the offers sorted, priced on the trade sequence, and an empty list cancels them", async () => {
    const { fake } = setup();
    const result = await put(fake, [no(510_000, credits(100)), yes(520_000, credits(100)), yes(510_000, credits(100))]);
    expect(result.kind).toBe("replaced");
    const book = fake.book(MARKET_1);
    expect(book?.offers).toEqual([yes(510_000, credits(100)), yes(520_000, credits(100)), no(510_000, credits(100))]);
    expect(book?.offersPricedOnSequence).toBe(0);
    if (result.kind === "replaced") expect(result.book).toEqual(book);

    expect((await put(fake, [])).kind).toBe("replaced");
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBeNull();
  });

  it("answers not_found for an unknown market and stale_sequence with the current sequence", async () => {
    const { fake } = setup();
    expect(await put(fake, GOOD_OFFERS, MARKET_2)).toEqual({ kind: "not_found" });
    expect(await put(fake, GOOD_OFFERS, MARKET_1, 3)).toEqual({ kind: "stale_sequence", tradeSequence: 0 });
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
  });

  it("answers market_not_open for a closed, resolved or unfunded market and at or after the close time, and accepts a funded one", async () => {
    const { clock, fake } = setup();
    fake.setStatus(MARKET_1, "closed");
    expect(await put(fake, GOOD_OFFERS)).toEqual({ kind: "market_not_open" });
    fake.setStatus(MARKET_1, "resolved");
    expect(await put(fake, GOOD_OFFERS)).toEqual({ kind: "market_not_open" });

    fake.addMarket(marketOf(MARKET_2, { fundingCredits: null }));
    expect(await put(fake, [], MARKET_2)).toEqual({ kind: "market_not_open" });

    fake.addMarket(marketOf(MARKET_1, { status: "funded" }));
    expect((await put(fake, GOOD_OFFERS)).kind).toBe("replaced");

    fake.addMarket(marketOf(MARKET_1, { closeTime: new Date(clock.now().getTime() + 1000) }));
    clock.advanceMs(999);
    expect((await put(fake, GOOD_OFFERS)).kind).toBe("replaced");
    clock.advanceMs(1);
    expect(await put(fake, GOOD_OFFERS)).toEqual({ kind: "market_not_open" });
  });

  it("checks in trading's order: unknown, stale, not open, then the offers", async () => {
    const { fake } = setup();
    fake.setStatus(MARKET_1, "closed");
    expect(await put(fake, [yes(555_000, 1)], MARKET_1, 9)).toEqual({ kind: "stale_sequence", tradeSequence: 0 });
    expect(await put(fake, [yes(555_000, 1)], MARKET_1, 0)).toEqual({ kind: "market_not_open" });
  });

  it("refuses with 400 validation_failed: off the grid, no size, a repeated price, too many per side", async () => {
    const { fake } = setup(2);
    const cases: Offer[][] = [
      [yes(515_000, credits(1))],
      [yes(510_000, 0)],
      [yes(510_000, credits(1)), yes(510_000, credits(2))],
      [yes(510_000, credits(1)), yes(520_000, credits(1)), yes(530_000, credits(1))],
    ];
    for (const offers of cases) {
      const result = await put(fake, offers);
      expect(result).toMatchObject({ kind: "refused", status: 400, code: "validation_failed" });
    }
    // The detail names the broken rule.
    const tooMany = await put(fake, cases[3] ?? []);
    expect(tooMany).toMatchObject({ detail: expect.stringContaining("more than 2") as string });
  });

  it("refuses with 400 crossed_offers when the cheapest YES and NO cost less than a credit together", async () => {
    const { fake } = setup();
    expect(await put(fake, [yes(400_000, credits(1)), no(500_000, credits(1))])).toMatchObject({ kind: "refused", status: 400, code: "crossed_offers" });
    expect((await put(fake, [yes(400_000, credits(1)), no(600_000, credits(1))])).kind).toBe("replaced");
    // A list that is both off the grid and crossed is a validation failure first, as in trading.
    expect(await put(fake, [yes(405_000, credits(1)), no(500_000, credits(1))])).toMatchObject({ code: "validation_failed" });
  });

  it("refuses with 409 insufficient_holdings when a side offers more than the account holds plus its credits", async () => {
    const { fake } = setup();
    fake.addMarket(marketOf(MARKET_1), { balanceMicro: credits(10), yesMicro: credits(40), noMicro: credits(50) });
    expect((await put(fake, [yes(510_000, credits(50)), no(510_000, credits(60))])).kind).toBe("replaced");
    expect(await put(fake, [yes(510_000, credits(51))])).toMatchObject({ kind: "refused", status: 409, code: "insufficient_holdings" });
    expect(await put(fake, [yes(400_000, credits(51)), no(500_000, credits(1))])).toMatchObject({ code: "crossed_offers" });
  });

  it("applies the limit per side that setMaxOffersPerSide sets, and reports it in the book", async () => {
    const { fake } = setup(2);
    const three = [yes(510_000, credits(1)), yes(520_000, credits(1)), yes(530_000, credits(1))];
    expect((await put(fake, three)).kind).toBe("refused");
    fake.setMaxOffersPerSide(3);
    expect(fake.book(MARKET_1)?.maxOffersPerSide).toBe(3);
    expect((await put(fake, three)).kind).toBe("replaced");
    for (const bad of [0, 51, 1.5]) expect(() => fake.setMaxOffersPerSide(bad)).toThrow(RangeError);
    expect(() => new FakeTradingClient({ clock: new TestClock(), maxOffersPerSide: 0 })).toThrow(RangeError);
  });
});

describe("FakeTradingClient: trade", () => {
  it("fills from the cheapest offer up, charges ceil per fill, raises the sequence and keeps the priced-on sequence", async () => {
    const { fake } = setup();
    await put(fake, [yes(510_000, credits(100)), yes(520_000, credits(100)), no(510_000, credits(100))]);
    fake.trade(MARKET_1, "YES", credits(150));
    const book = fake.book(MARKET_1);
    // 100 shares at 0.51 and 50 at 0.52: 51 + 26 credits.
    expect(book?.holdings).toEqual({ balanceMicro: credits(77), yesMicro: credits(5000 - 150), noMicro: credits(5000) });
    expect(book?.offers).toEqual([yes(520_000, credits(50)), no(510_000, credits(100))]);
    expect(book?.tradeSequence).toBe(1);
    expect(book?.market.tradeSequence).toBe(1);
    expect(book?.offersPricedOnSequence).toBe(0);
  });

  it("rounds the cost of a fill up to a microcredit", async () => {
    const { fake } = setup();
    await put(fake, GOOD_OFFERS);
    fake.trade(MARKET_1, "YES", 3);
    // 3 microshares at 0.51 is 1.53 microcredits, charged as 2.
    expect(fake.book(MARKET_1)?.holdings.balanceMicro).toBe(2);
  });

  it("creates the pairs the bot lacks from its credits, the payment included", async () => {
    const { fake } = setup();
    fake.addMarket(marketOf(MARKET_1), { balanceMicro: credits(100), yesMicro: credits(10), noMicro: credits(10) });
    await put(fake, [yes(500_000, credits(20)), no(500_000, credits(20))]);
    fake.trade(MARKET_1, "YES", credits(15));
    // The 15 shares cost 7.5 credits; 5 pairs are created for the 5 shares the holding of 10 lacks.
    expect(fake.book(MARKET_1)?.holdings).toEqual({ balanceMicro: credits(102.5), yesMicro: 0, noMicro: credits(15) });
  });

  it("removes an emptied level, and leaves no priced-on sequence when no offer is left", async () => {
    const { fake } = setup();
    await put(fake, [yes(510_000, credits(10)), no(510_000, credits(10))]);
    fake.trade(MARKET_1, "YES", credits(10));
    expect(fake.book(MARKET_1)?.offers).toEqual([no(510_000, credits(10))]);
    fake.trade(MARKET_1, "NO", credits(10));
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBeNull();
    expect(fake.book(MARKET_1)?.tradeSequence).toBe(2);
  });

  it("throws a plain error for a test mistake: unknown or not open market, no shares, more than offered", async () => {
    const { fake } = setup();
    await put(fake, GOOD_OFFERS);
    expect(() => fake.trade(MARKET_2, "YES", 1)).toThrow("knows no market");
    expect(() => fake.trade(MARKET_1, "YES", 0)).toThrow("positive");
    expect(() => fake.trade(MARKET_1, "NO", credits(101))).toThrow("cannot fill");
    expect(() => fake.trade(MARKET_1, "YES", credits(300))).toThrow("cannot fill");
    fake.setStatus(MARKET_1, "closed");
    expect(() => fake.trade(MARKET_1, "YES", 1)).toThrow("closed");
  });

  it("keeps the remaining book backed and not crossed over random sessions of quotes and fills", async () => {
    const random = new SeededRandom(2026);
    for (let session = 0; session < 25; session += 1) {
      const { fake } = setup();
      const startingPriceMicro = (random.int(5, 95) * 10_000);
      fake.addMarket(marketOf(MARKET_1, { startingPriceMicro, fundingCredits: random.int(100, 5000) }));
      for (let step = 0; step < 12; step += 1) {
        const book = fake.book(MARKET_1);
        if (book === null || book.market.fundingMicro === null) throw new Error("expected a funded book");
        const offers = computeOffers({ holdings: book.holdings, fundingMicro: book.market.fundingMicro, startingPriceMicro, maxOffersPerSide: book.maxOffersPerSide }, { spreadMicro: 20_000, levels: 3 });
        const result = await put(fake, offers, MARKET_1, book.tradeSequence);
        expect(result.kind).toBe("replaced");
        const side: Side = random.next() < 0.5 ? "YES" : "NO";
        const offered = (fake.book(MARKET_1)?.offers ?? []).filter((offer) => offer.side === side).reduce((sum, offer) => sum + offer.sharesMicro, 0);
        if (offered === 0) continue;
        fake.trade(MARKET_1, side, random.int(1, offered));
        const after = fake.book(MARKET_1);
        expect(offerViolations(after?.offers ?? [], after?.holdings ?? { balanceMicro: 0, yesMicro: 0, noMicro: 0 }, 10)).toEqual([]);
      }
    }
  });
});

describe("FakeTradingClient: statuses, injected failures and the demo market", () => {
  it("cancels every offer when a market closes or resolves, and keeps them when it opens", async () => {
    const { fake } = setup();
    fake.addMarket(marketOf(MARKET_1, { status: "funded" }));
    await put(fake, GOOD_OFFERS);
    fake.setStatus(MARKET_1, "open");
    expect(fake.book(MARKET_1)?.offers).toHaveLength(3);
    expect(fake.book(MARKET_1)?.market.version).toBe(2);
    fake.setStatus(MARKET_1, "resolved");
    expect(fake.book(MARKET_1)?.offers).toEqual([]);
    expect(fake.book(MARKET_1)?.offersPricedOnSequence).toBeNull();
    expect(() => fake.setStatus(MARKET_2, "closed")).toThrow("knows no market");
  });

  it("makes the next call fail as asked, once, and records the failed call", async () => {
    const { fake } = setup();
    fake.failNext("unavailable");
    await expect(fake.getBotBook(MARKET_1, ctx())).rejects.toMatchObject({ name: "TradingUnavailable", scope: "call" });
    expect(await fake.getBotBook(MARKET_1, ctx())).not.toBeNull();

    fake.failNext("unavailable_service");
    const service = await fake.listOpenMarkets({ cursor: null, limit: 1 }, ctx()).catch((error: unknown) => error);
    expect(service).toBeInstanceOf(TradingUnavailable);
    expect((service as TradingUnavailable).scope).toBe("service");

    fake.failNext("contract");
    await expect(put(fake, [])).rejects.toBeInstanceOf(TradingContractViolation);
    expect((await put(fake, [])).kind).toBe("replaced");
    expect(fake.calls.map((call) => call.method)).toEqual(["book", "book", "list", "replace", "replace"]);
  });

  it("answers an injected stale_sequence only to a replacement, without a trade having happened", async () => {
    const { fake } = setup();
    fake.failNext("stale");
    expect(await fake.getBotBook(MARKET_1, ctx())).not.toBeNull();
    expect(await put(fake, GOOD_OFFERS)).toEqual({ kind: "stale_sequence", tradeSequence: 0 });
    expect((await put(fake, GOOD_OFFERS)).kind).toBe("replaced");
    // An unknown market is answered 404 even when a stale answer was queued (the queued answer is used up by the call).
    fake.failNext("stale");
    expect(await put(fake, GOOD_OFFERS, MARKET_2)).toEqual({ kind: "not_found" });
  });

  it("can restrict an injected failure to one method or one market, and queues several", async () => {
    const { fake } = setup();
    fake.addMarket(marketOf(MARKET_2));
    fake.failNext("unavailable", { method: "replace" });
    fake.failNext("contract", { marketId: MARKET_2 });
    expect(await fake.getBotBook(MARKET_1, ctx())).not.toBeNull();
    await expect(fake.getBotBook(MARKET_2, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
    await expect(put(fake, [])).rejects.toBeInstanceOf(TradingUnavailable);
    fake.failNext("unavailable");
    fake.failNext("contract");
    await expect(fake.getBotBook(MARKET_1, ctx())).rejects.toBeInstanceOf(TradingUnavailable);
    await expect(fake.getBotBook(MARKET_1, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
    expect(await fake.getBotBook(MARKET_1, ctx())).not.toBeNull();
  });

  it("fails every read of one market until cleared, and only the read", async () => {
    const { fake } = setup();
    fake.failMarket(MARKET_1, "unavailable");
    for (let attempt = 0; attempt < 2; attempt += 1) await expect(fake.getBotBook(MARKET_1, ctx())).rejects.toBeInstanceOf(TradingUnavailable);
    expect((await put(fake, GOOD_OFFERS)).kind).toBe("replaced");
    fake.failMarket(MARKET_1, "contract");
    await expect(fake.getBotBook(MARKET_1, ctx())).rejects.toBeInstanceOf(TradingContractViolation);
    fake.failMarket(MARKET_1, null);
    expect(await fake.getBotBook(MARKET_1, ctx())).not.toBeNull();
  });

  it("offers a demo market: one open market of a demo tenant, 5000 credits at 0.60, closing 30 days after the clock", async () => {
    const clock = new TestClock();
    const fake = FakeTradingClient.withDemoMarket(clock);
    const page = await fake.listOpenMarkets({ cursor: null, limit: 10 }, ctx());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      marketId: DEMO_MARKET_ID,
      tenantId: DEMO_TENANT_ID,
      status: "open",
      startingPriceMicro: 600_000,
      fundingMicro: credits(5000),
      tradeSequence: 0,
    });
    expect(page.items[0]?.closeTime?.getTime()).toBe(clock.now().getTime() + 30 * DAY_MS);
    const book = await fake.getBotBook(DEMO_MARKET_ID, ctx());
    expect(book?.holdings).toEqual({ balanceMicro: 0, yesMicro: credits(5000), noMicro: credits(5000) });
  });
});
