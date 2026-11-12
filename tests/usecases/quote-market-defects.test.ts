import { describe, expect, it, vi } from "vitest";
import type { BotBook } from "../../src/domain/book.js";
import type { Offer } from "../../src/domain/offers.js";
import { computeOffers } from "../../src/domain/pricing.js";
import type * as Pricing from "../../src/domain/pricing.js";
import type { OpenMarketsPage, ReplaceOffersRequest, ReplaceResult, TradingClient } from "../../src/usecases/ports.js";
import { QuoteMarket } from "../../src/usecases/quote-market.js";
import { FixedRandom, InstantDelay, MARKET_1, RecordingLogger, TENANT_A, TestClock, TestSettings, bookOf, credits } from "../support/fakes.js";

// The pricing never produces a list that breaks trading's rules (its own tests show that), so the bot's check of the
// list before it sends it cannot be reached with real prices. These tests replace computeOffers to prove the check holds:
// a list that breaks a rule is never sent, and is reported as a defect of the pricing.
vi.mock("../../src/domain/pricing.js", async (importOriginal) => ({ ...(await importOriginal<typeof Pricing>()), computeOffers: vi.fn() }));

class OneBook implements TradingClient {
  readonly requests: ReplaceOffersRequest[] = [];
  constructor(private readonly book: BotBook) {}
  listOpenMarkets(): Promise<OpenMarketsPage> {
    return Promise.reject(new Error("not used"));
  }
  getBotBook(): Promise<BotBook | null> {
    return Promise.resolve(this.book);
  }
  replaceBotOrders(_marketId: string, request: ReplaceOffersRequest): Promise<ReplaceResult> {
    this.requests.push(request);
    return Promise.reject(new Error("the list must not be sent"));
  }
}

function run(book: BotBook) {
  const trading = new OneBook(book);
  const logger = new RecordingLogger();
  const quote = new QuoteMarket({ trading, settings: new TestSettings(), clock: new TestClock(), delay: new InstantDelay(), random: new FixedRandom(), logger });
  const execute = () => quote.execute({ marketId: MARKET_1, trigger: "recheck", tenantId: TENANT_A, knownSequence: null, correlationId: "corr-1" });
  return { trading, logger, execute };
}

const yes = (priceMicro: number, sharesMicro: number): Offer => ({ side: "YES", priceMicro, sharesMicro });
const no = (priceMicro: number, sharesMicro: number): Offer => ({ side: "NO", priceMicro, sharesMicro });

describe("QuoteMarket: a computed list that breaks trading's rules", () => {
  it.each([
    ["crossed", [yes(400_000, credits(1)), no(500_000, credits(1))], "crossed"],
    ["backed", [yes(510_000, credits(6000))], "can deliver"],
    ["too many on a side", [yes(510_000, credits(1)), yes(520_000, credits(1))], "more than 1"],
    ["off the grid", [yes(515_000, credits(1))], "off the grid"],
  ] as const)("does not send a list that is not %s, and reports a defect", async (_name, offers, expected) => {
    vi.mocked(computeOffers).mockReturnValueOnce([...offers]);
    const { trading, logger, execute } = run(bookOf({ maxOffersPerSide: expected === "more than 1" ? 1 : 10 }));
    const outcome = await execute();
    expect(outcome).toMatchObject({ kind: "refused", status: 0, code: "invariant_violated", detail: expect.stringContaining(expected) as string });
    expect(trading.requests).toEqual([]);
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", message: "The computed offers break trading's rules and were not sent", fields: { marketId: MARKET_1, offers: offers.length } });
  });

  it("rethrows an error that is not a DomainError: it is not a statement about this book", async () => {
    vi.mocked(computeOffers).mockImplementationOnce(() => {
      throw new TypeError("unexpected");
    });
    await expect(run(bookOf()).execute()).rejects.toThrow(TypeError);
  });
});
