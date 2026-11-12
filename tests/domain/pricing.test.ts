import { describe, expect, it } from "vitest";
import type { Holdings } from "../../src/domain/book.js";
import { DomainError } from "../../src/domain/errors.js";
import { TRADING_DEFAULT_MAX_OFFERS_PER_SIDE, bestPriceMicro, offerViolations, offeredBySide, sortOffers } from "../../src/domain/offers.js";
import type { Offer } from "../../src/domain/offers.js";
import {
  LEVELS_MAX,
  SPREAD_MICRO_MAX,
  SPREAD_MICRO_MIN,
  computeOffers,
  heldBackOf,
  isqrtCeil,
  isqrtFloor,
  levelsQuoted,
  poolOf,
  referencePriceMicro,
  referencePriceOf,
} from "../../src/domain/pricing.js";
import type { PricingInput, PricingSettings } from "../../src/domain/pricing.js";
import { MAX_PRICE_MICRO, MICROS_PER_UNIT, MIN_PRICE_MICRO, PRICE_STEP_MICRO, SIDES, ceilToGrid } from "../../src/domain/units.js";
import type { Side } from "../../src/domain/units.js";
import { SeededRandom, credits } from "../support/fakes.js";

const DEFAULTS: PricingSettings = { spreadMicro: 20_000, levels: 3 };
const GRID_PRICES = Array.from({ length: 99 }, (_, index) => MIN_PRICE_MICRO + index * PRICE_STEP_MICRO);

/** A book right after the funding call: the funding as pairs, no credits. */
function funded(fundingCredits: number, startingPriceMicro: number): PricingInput {
  const fundingMicro = credits(fundingCredits);
  return { fundingMicro, startingPriceMicro, maxOffersPerSide: TRADING_DEFAULT_MAX_OFFERS_PER_SIDE, holdings: { balanceMicro: 0, yesMicro: fundingMicro, noMicro: fundingMicro } };
}

/** trading's cost of a fill: ceil(shares x price / 10^6) microcredits (ADR-055). */
function costOf(shares: number, priceMicro: number): number {
  return Number((BigInt(shares) * BigInt(priceMicro) + 999_999n) / 1_000_000n);
}

/**
 * trading's planBuy (order-book.ts): spends exactly `budgetMicro` from the cheapest offer of `side` up, whole levels
 * while the budget covers them, then floor(rest x 10^6 / price) microshares of the next one; null when the offers
 * cannot absorb the amount (trading answers insufficient_liquidity).
 */
function planBuy(offers: readonly Offer[], side: Side, budgetMicro: number): Array<{ offer: Offer; shares: number; cost: number }> | null {
  const fills: Array<{ offer: Offer; shares: number; cost: number }> = [];
  let left = budgetMicro;
  for (const offer of sortOffers(offers).filter((candidate) => candidate.side === side)) {
    if (left === 0) break;
    const full = costOf(offer.sharesMicro, offer.priceMicro);
    const shares = full <= left ? offer.sharesMicro : Number((BigInt(left) * 1_000_000n) / BigInt(offer.priceMicro));
    if (shares === 0) break;
    const cost = full <= left ? full : costOf(shares, offer.priceMicro);
    fills.push({ offer, shares, cost });
    left -= cost;
  }
  return left === 0 ? fills : null;
}

/** y x n of the pool the curve sees: a fill that pays at least what the curve asks never lowers it. */
function poolProduct(input: PricingInput): bigint {
  const pool = poolOf(input.holdings, heldBackOf(input.fundingMicro, input.startingPriceMicro));
  return pool.yesMicro * pool.noMicro;
}

/**
 * A trader buys `shares` microshares of an offer, booked as trading books it: the cost is ceil(shares x price / 10^6)
 * (ADR-055), the bot receives it, and pairs the bot lacks are minted from its credits.
 */
function fill(holdings: Holdings, offer: Offer, shares: number): Holdings {
  const cost = costOf(shares, offer.priceMicro);
  let { balanceMicro, yesMicro, noMicro } = holdings;
  balanceMicro += cost;
  const held = offer.side === "YES" ? yesMicro : noMicro;
  if (held < shares) {
    const minted = shares - held;
    yesMicro += minted;
    noMicro += minted;
    balanceMicro -= minted;
  }
  if (offer.side === "YES") yesMicro -= shares;
  else noMicro -= shares;
  return { balanceMicro, yesMicro, noMicro };
}

/** A random trading session from the funding: `trades` fills of random size at the bot's best offers. */
function session(random: SeededRandom, input: PricingInput, settings: PricingSettings, trades: number): PricingInput[] {
  const states = [input];
  let current = input;
  for (let i = 0; i < trades; i += 1) {
    const offers = computeOffers(current, settings);
    const side: Side = random.next() < 0.5 ? "YES" : "NO";
    const best = sortOffers(offers).find((offer) => offer.side === side);
    if (!best) continue;
    const shares = Math.max(1, Math.floor(best.sharesMicro * random.next()));
    current = { ...current, holdings: fill(current.holdings, best, shares) };
    states.push(current);
  }
  return states;
}

function randomSettings(random: SeededRandom): PricingSettings {
  // A third of the runs at the narrowest spread, where level 0's price meets the top of its segment exactly.
  const spreadMicro = random.next() < 1 / 3 ? SPREAD_MICRO_MIN : random.int(SPREAD_MICRO_MIN, SPREAD_MICRO_MAX);
  return { spreadMicro, levels: random.int(1, LEVELS_MAX) };
}

describe("isqrt", () => {
  it("is exact for small and large numbers", () => {
    expect(isqrtFloor(0n)).toBe(0n);
    expect(isqrtFloor(1n)).toBe(1n);
    expect(isqrtFloor(15n)).toBe(3n);
    expect(isqrtFloor(16n)).toBe(4n);
    expect(isqrtCeil(15n)).toBe(4n);
    expect(isqrtCeil(16n)).toBe(4n);
    const random = new SeededRandom(7);
    for (let i = 0; i < 500; i += 1) {
      const n = BigInt(random.int(0, 2 ** 31)) * BigInt(random.int(0, 2 ** 31)) * BigInt(random.int(1, 2 ** 20));
      const root = isqrtFloor(n);
      expect(root * root <= n && (root + 1n) * (root + 1n) > n).toBe(true);
    }
  });

  it("refuses a negative number", () => {
    expect(() => isqrtFloor(-1n)).toThrow(DomainError);
  });
});

describe("heldBackOf and the starting pool", () => {
  it("holds back the expensive side so that the pool starts at the starting price", () => {
    // 5000 credits at 0.70: the pool keeps 5000 x 0.3 / 0.7 = 2142.857143 YES (rounded to a microshare) and 5000 NO.
    expect(heldBackOf(credits(5000), 700_000)).toEqual({ yesMicro: 2_857_142_857, noMicro: 0 });
    expect(heldBackOf(credits(5000), 300_000)).toEqual({ yesMicro: 0, noMicro: 2_857_142_857 });
    expect(heldBackOf(credits(5000), 500_000)).toEqual({ yesMicro: 0, noMicro: 0 });
  });

  it("starts every grid price at exactly that price, for small and large fundings", () => {
    for (const fundingCredits of [1, 7, 5000, 1_000_000]) {
      for (const p0 of GRID_PRICES) expect(referencePriceOf(funded(fundingCredits, p0))).toBe(p0);
    }
  });

  it("places the first offers half the spread around the starting price", () => {
    for (const p0 of GRID_PRICES) {
      const offers = computeOffers(funded(5000, p0), DEFAULTS);
      const yes = ceilToGrid(p0 + 10_000);
      const no = ceilToGrid(MICROS_PER_UNIT - p0 + 10_000);
      expect(bestPriceMicro(offers, "YES")).toBe(yes <= MAX_PRICE_MICRO ? yes : null);
      expect(bestPriceMicro(offers, "NO")).toBe(no <= MAX_PRICE_MICRO ? no : null);
    }
  });

  it("refuses a funding or a starting price outside the contract", () => {
    expect(() => heldBackOf(0, 500_000)).toThrow(DomainError);
    expect(() => heldBackOf(credits(1), 505_000)).toThrow(DomainError);
    expect(() => heldBackOf(credits(1), 1_000_000)).toThrow(DomainError);
  });
});

describe("computeOffers", () => {
  it("quotes a fresh 50/50 market of 5000 credits with three levels of about 200 shares per side", () => {
    const offers = computeOffers(funded(5000, 500_000), DEFAULTS);
    expect(offers.map((offer) => [offer.side, offer.priceMicro])).toEqual([
      ["YES", 510_000],
      ["YES", 520_000],
      ["YES", 530_000],
      ["NO", 510_000],
      ["NO", 520_000],
      ["NO", 530_000],
    ]);
    for (const offer of offers) {
      expect(offer.sharesMicro).toBeGreaterThan(credits(195));
      expect(offer.sharesMicro).toBeLessThan(credits(205));
    }
  });

  it("honours LEVELS at the narrowest spread without crossing", () => {
    const offers = computeOffers(funded(5000, 500_000), { spreadMicro: SPREAD_MICRO_MIN, levels: 1 });
    expect(offers).toHaveLength(2);
    expect(bestPriceMicro(offers, "YES")! + bestPriceMicro(offers, "NO")!).toBe(MICROS_PER_UNIT + SPREAD_MICRO_MIN);
  });

  it("runs out of levels near 0.01 and 0.99 instead of pricing a side below the curve", () => {
    const sideOf = (offers: Offer[], side: Side): Offer[] => offers.filter((offer) => offer.side === side);
    for (const fundingCredits of [1, 5000, 1_000_000]) {
      const at99 = computeOffers(funded(fundingCredits, 990_000), DEFAULTS);
      expect(sideOf(at99, "YES")).toEqual([]);
      expect(sideOf(at99, "NO").map((offer) => offer.priceMicro)).toEqual([20_000, 30_000, 40_000]);
      const at98 = computeOffers(funded(fundingCredits, 980_000), DEFAULTS);
      expect(sideOf(at98, "YES").map((offer) => offer.priceMicro)).toEqual([MAX_PRICE_MICRO]);
      const at01 = computeOffers(funded(fundingCredits, 10_000), DEFAULTS);
      expect(sideOf(at01, "NO")).toEqual([]);
      expect(sideOf(at01, "YES")).toHaveLength(3);
      expect(sideOf(computeOffers(funded(fundingCredits, 20_000), DEFAULTS), "NO").map((offer) => offer.priceMicro)).toEqual([MAX_PRICE_MICRO]);
    }
  });

  it("offers nothing when a side of the pool is empty", () => {
    const input: PricingInput = { fundingMicro: credits(10), startingPriceMicro: 500_000, maxOffersPerSide: 10, holdings: { balanceMicro: 0, yesMicro: 0, noMicro: credits(10) } };
    expect(computeOffers(input, DEFAULTS)).toEqual([]);
    expect(referencePriceMicro({ yesMicro: 0n, noMicro: 5n })).toBeNull();
  });

  it("refuses settings outside their ranges and holdings that are not safe integers", () => {
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: -1, levels: 3 })).toThrow(DomainError);
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: 0, levels: 3 })).toThrow(DomainError);
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: SPREAD_MICRO_MIN - 1, levels: 3 })).toThrow(DomainError);
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: SPREAD_MICRO_MAX + 1, levels: 3 })).toThrow(DomainError);
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: SPREAD_MICRO_MIN, levels: 0 })).toThrow(DomainError);
    expect(() => computeOffers(funded(10, 500_000), { spreadMicro: SPREAD_MICRO_MIN, levels: LEVELS_MAX + 1 })).toThrow(DomainError);
    const broken: PricingInput = { ...funded(10, 500_000), holdings: { balanceMicro: -1, yesMicro: 0, noMicro: 0 } };
    expect(() => computeOffers(broken, DEFAULTS)).toThrow(DomainError);
  });
});

describe("levels per side: min(LEVELS, trading's maxOffersPerSide)", () => {
  const FIVE: PricingSettings = { spreadMicro: 20_000, levels: 5 };
  const perSide = (offers: Offer[], side: Side): Offer[] => sortOffers(offers).filter((offer) => offer.side === side);

  it("quotes the smaller of LEVELS and the book's limit, and the levels it keeps are the cheapest ones of the full ladder", () => {
    const base = funded(5000, 500_000);
    const full = computeOffers({ ...base, maxOffersPerSide: 10 }, FIVE);
    expect(perSide(full, "YES")).toHaveLength(5);
    expect(perSide(full, "NO")).toHaveLength(5);
    for (const maxOffersPerSide of [1, 2, 3, 4, 5, 6, 10, 50]) {
      const offers = computeOffers({ ...base, maxOffersPerSide }, FIVE);
      const kept = Math.min(FIVE.levels, maxOffersPerSide);
      for (const side of SIDES) expect(perSide(offers, side), `${side} at limit ${maxOffersPerSide}`).toEqual(perSide(full, side).slice(0, kept));
    }
  });

  it("never exceeds trading's limit, even when LEVELS is at its maximum and the limit is far below it", () => {
    const base = funded(5000, 500_000);
    const ten: PricingSettings = { spreadMicro: 20_000, levels: LEVELS_MAX };
    for (const maxOffersPerSide of [1, 3, 9]) {
      const offers = computeOffers({ ...base, maxOffersPerSide }, ten);
      expect(offerViolations(offers, base.holdings, maxOffersPerSide)).toEqual([]);
      for (const side of SIDES) expect(perSide(offers, side)).toHaveLength(maxOffersPerSide);
    }
    // The same list is refused by a limit one lower: the check above does bite.
    const three = computeOffers({ ...base, maxOffersPerSide: 3 }, ten);
    expect(offerViolations(three, base.holdings, 2)).toEqual([expect.stringContaining("more than 2"), expect.stringContaining("more than 2")]);
  });

  it("changes nothing when the limit is at or above LEVELS", () => {
    const base = funded(5000, 500_000);
    const atLevels = computeOffers({ ...base, maxOffersPerSide: DEFAULTS.levels }, DEFAULTS);
    expect(computeOffers({ ...base, maxOffersPerSide: 50 }, DEFAULTS)).toEqual(atLevels);
    expect(atLevels).toEqual(computeOffers(funded(5000, 500_000), DEFAULTS));
    expect(atLevels).toHaveLength(2 * DEFAULTS.levels);
  });

  it("is levelsQuoted: the minimum, with both numbers checked", () => {
    expect(levelsQuoted({ spreadMicro: 20_000, levels: 3 }, 10)).toBe(3);
    expect(levelsQuoted({ spreadMicro: 20_000, levels: 10 }, 3)).toBe(3);
    expect(levelsQuoted({ spreadMicro: 20_000, levels: 4 }, 4)).toBe(4);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => levelsQuoted(DEFAULTS, bad), String(bad)).toThrow(DomainError);
      expect(() => computeOffers({ ...funded(10, 500_000), maxOffersPerSide: bad }, DEFAULTS), String(bad)).toThrow(DomainError);
    }
    expect(() => levelsQuoted({ spreadMicro: 20_000, levels: 0 }, 5)).toThrow(DomainError);
  });

  it("holds over random books, limits and LEVELS: the list passes trading's rules at that limit", () => {
    const random = new SeededRandom(1111);
    for (let run = 0; run < 1000; run += 1) {
      const input: PricingInput = {
        fundingMicro: credits(random.int(1, 1_000_000)),
        startingPriceMicro: GRID_PRICES[random.int(0, GRID_PRICES.length - 1)]!,
        maxOffersPerSide: random.int(1, 12),
        holdings: { balanceMicro: random.int(0, 2 ** 40), yesMicro: random.int(0, 2 ** 42), noMicro: random.int(0, 2 ** 42) },
      };
      const settings = randomSettings(random);
      const offers = computeOffers(input, settings);
      expect(offerViolations(offers, input.holdings, input.maxOffersPerSide)).toEqual([]);
      for (const side of SIDES) expect(perSide(offers, side).length).toBeLessThanOrEqual(Math.min(settings.levels, input.maxOffersPerSide));
    }
  });
});

describe("properties over random books", () => {
  it("every list from a trading session is accepted by trading's rules and never offers a held-back share", () => {
    const random = new SeededRandom(20261111);
    for (let run = 0; run < 150; run += 1) {
      const start = funded(random.int(1, 1_000_000), GRID_PRICES[random.int(0, GRID_PRICES.length - 1)]!);
      const settings = randomSettings(random);
      for (const state of session(random, start, settings, 25)) {
        const offers = computeOffers(state, settings);
        expect(offerViolations(offers, state.holdings, settings.levels)).toEqual([]);
        expect(computeOffers(state, settings)).toEqual(offers);
        const heldBack = heldBackOf(state.fundingMicro, state.startingPriceMicro);
        const pool = poolOf(state.holdings, heldBack);
        const offered = offeredBySide(offers);
        expect(offered.YES <= pool.yesMicro && offered.NO <= pool.noMicro).toBe(true);
        // The held-back shares stay in the bot account: holding + credits never fall below them.
        const { holdings } = state;
        expect(holdings.yesMicro + holdings.balanceMicro >= heldBack.yesMicro).toBe(true);
        expect(holdings.noMicro + holdings.balanceMicro >= heldBack.noMicro).toBe(true);
        const reference = referencePriceMicro(pool);
        const half = Math.ceil(settings.spreadMicro / 2);
        for (const offer of offers) {
          expect(offer.sharesMicro).toBeGreaterThan(0);
          const sideReference = offer.side === "YES" ? reference! : MICROS_PER_UNIT - reference!;
          expect(offer.priceMicro).toBeGreaterThanOrEqual(sideReference + half);
        }
      }
    }
  });

  it("holds for arbitrary holdings too, not only those a session reaches", () => {
    const random = new SeededRandom(42);
    for (let run = 0; run < 2000; run += 1) {
      const input: PricingInput = {
        fundingMicro: credits(random.int(1, 1_000_000)),
        startingPriceMicro: GRID_PRICES[random.int(0, GRID_PRICES.length - 1)]!,
        maxOffersPerSide: 10,
        holdings: { balanceMicro: random.int(0, 2 ** 40), yesMicro: random.int(0, 2 ** 42), noMicro: random.int(0, 2 ** 42) },
      };
      const settings = randomSettings(random);
      const offers = computeOffers(input, settings);
      expect(offerViolations(offers, input.holdings, settings.levels)).toEqual([]);
      for (const side of SIDES) expect(offers.filter((offer) => offer.side === side).length).toBeLessThanOrEqual(settings.levels);
    }
  });

  it("moves the price the way the trade went: a YES fill never lowers YES, a NO fill never raises it", () => {
    const random = new SeededRandom(99);
    for (let run = 0; run < 300; run += 1) {
      const start = funded(random.int(1, 100_000), GRID_PRICES[random.int(0, GRID_PRICES.length - 1)]!);
      const settings = randomSettings(random);
      const states = session(random, start, settings, 10);
      for (let i = 1; i < states.length; i += 1) {
        const before = states[i - 1]!;
        const after = states[i]!;
        const priceBefore = referencePriceOf(before)!;
        const priceAfter = referencePriceOf(after)!;
        const boughtYes = after.holdings.yesMicro - before.holdings.yesMicro < after.holdings.noMicro - before.holdings.noMicro;
        if (boughtYes) expect(priceAfter).toBeGreaterThanOrEqual(priceBefore);
        else expect(priceAfter).toBeLessThanOrEqual(priceBefore);
      }
    }
  });
});

describe("never below the curve", () => {
  const randomGridPrice = (random: SeededRandom): number => GRID_PRICES[random.int(0, GRID_PRICES.length - 1)]!;

  it("prices every level at or above the curve's price at the top of its segment, so whole levels never lower k", () => {
    const random = new SeededRandom(5150);
    for (let run = 0; run < 2000; run += 1) {
      const input: PricingInput =
        random.next() < 0.5
          ? funded(random.int(1, 1_000_000), randomGridPrice(random))
          : {
              fundingMicro: credits(random.int(1, 1_000_000)),
              startingPriceMicro: randomGridPrice(random),
              maxOffersPerSide: 10,
              holdings: { balanceMicro: random.int(0, 2 ** 40), yesMicro: random.int(0, 2 ** 42), noMicro: random.int(0, 2 ** 42) },
            };
      const settings = randomSettings(random);
      const pool = poolOf(input.holdings, heldBackOf(input.fundingMicro, input.startingPriceMicro));
      const reference = referencePriceMicro(pool);
      const offers = computeOffers(input, settings);
      if (reference === null) {
        expect(offers).toEqual([]);
        continue;
      }
      for (const side of SIDES) {
        const own = side === "YES" ? pool.yesMicro : pool.noMicro;
        const other = side === "YES" ? pool.noMicro : pool.yesMicro;
        const sideReference = side === "YES" ? reference : MICROS_PER_UNIT - reference;
        let sold = 0n;
        let paid = 0n;
        offers
          .filter((offer) => offer.side === side)
          .forEach((offer, index) => {
            // The offer at index i is level i or a later one (levels of size 0 are skipped), so this bound is safe.
            expect(offer.priceMicro).toBeGreaterThanOrEqual(Math.min(sideReference + (index + 1) * PRICE_STEP_MICRO, MAX_PRICE_MICRO));
            sold += BigInt(offer.sharesMicro);
            paid += BigInt(costOf(offer.sharesMicro, offer.priceMicro));
            // Selling these levels whole for their price leaves the pool on or above the curve y x n = k.
            expect((own - sold + paid) * (other + paid) >= own * other).toBe(true);
          });
      }
    }
  });

  it("never lets k fall, whatever the amounts and sides, with a requote before every buy, so a pair never costs a trader less than 1 credit", () => {
    const random = new SeededRandom(777);
    for (let run = 0; run < 150; run += 1) {
      let state = funded(random.int(1, 100_000), randomGridPrice(random));
      const settings = randomSettings(random);
      const bought = { YES: 0, NO: 0 };
      let spent = 0;
      for (let trade = 0; trade < 25; trade += 1) {
        const offers = computeOffers(state, settings);
        const side: Side = random.next() < 0.5 ? "YES" : "NO";
        const liquidity = offers.filter((offer) => offer.side === side).reduce((sum, offer) => sum + costOf(offer.sharesMicro, offer.priceMicro), 0);
        const maxCredits = Math.floor(liquidity / MICROS_PER_UNIT);
        if (maxCredits < 1) continue;
        const amount = random.next() < 0.5 ? random.int(1, Math.min(maxCredits, 5)) : random.int(1, maxCredits);
        const fills = planBuy(offers, side, credits(amount));
        expect(fills).not.toBeNull();
        const before = poolProduct(state);
        for (const { offer, shares, cost } of fills!) {
          state = { ...state, holdings: fill(state.holdings, offer, shares) };
          bought[side] += shares;
          spent += cost;
        }
        expect(poolProduct(state) >= before).toBe(true);
      }
      expect(Math.min(bought.YES, bought.NO)).toBeLessThanOrEqual(spent);
    }
  });

  /**
   * One buy of `amount` whole credits against offers that stay resting from an earlier quote (no requote in between): trading's
   * planBuy, the fills booked on the holdings, and the offers left over. Null when the offers cannot absorb the amount.
   */
  function buyResting(state: PricingInput, offers: readonly Offer[], side: Side, amount: number) {
    const plan = planBuy(offers, side, credits(amount));
    if (plan === null) return null;
    const left = offers.map((offer) => ({ ...offer }));
    let holdings = state.holdings;
    let shares = 0;
    let cost = 0;
    for (const taken of plan) {
      holdings = fill(holdings, taken.offer, taken.shares);
      const resting = left.find((offer) => offer.side === taken.offer.side && offer.priceMicro === taken.offer.priceMicro)!;
      resting.sharesMicro -= taken.shares;
      shares += taken.shares;
      cost += taken.cost;
    }
    return { state: { ...state, holdings }, offers: left.filter((offer) => offer.sharesMicro > 0), shares, cost };
  }

  it("keeps y x n at or above its value at the quote, whatever buys of either side hit the offers left resting before the next requote", () => {
    const random = new SeededRandom(4242);
    let windowsWithManyBuys = 0;
    let buysBelowThePoolBefore = 0;
    for (let run = 0; run < 400; run += 1) {
      let state: PricingInput =
        random.next() < 0.5
          ? funded(random.int(1, 1_000_000), randomGridPrice(random))
          : {
              fundingMicro: credits(random.int(1, 1_000_000)),
              startingPriceMicro: randomGridPrice(random),
              maxOffersPerSide: 10,
              holdings: { balanceMicro: random.int(0, 2 ** 40), yesMicro: random.int(0, 2 ** 42), noMicro: random.int(0, 2 ** 42) },
            };
      let offers: readonly Offer[] = computeOffers(state, randomSettings(random));
      const productAtQuote = poolProduct(state);
      const bought = { YES: 0, NO: 0 };
      let spent = 0;
      let buys = 0;
      for (let trade = random.int(1, 40); trade > 0; trade -= 1) {
        const side: Side = random.next() < 0.5 ? "YES" : "NO";
        const liquidity = offers.filter((offer) => offer.side === side).reduce((sum, offer) => sum + costOf(offer.sharesMicro, offer.priceMicro), 0);
        const maxCredits = Math.floor(liquidity / MICROS_PER_UNIT);
        if (maxCredits < 1) continue;
        const result = buyResting(state, offers, side, random.next() < 0.5 ? random.int(1, Math.min(maxCredits, 5)) : random.int(1, maxCredits));
        expect(result).not.toBeNull();
        const before = poolProduct(state);
        ({ state, offers } = result!);
        bought[side] += result!.shares;
        spent += result!.cost;
        buys += 1;
        // One buy may land below the pool just before it, never below the quote's own k.
        if (poolProduct(state) < before) buysBelowThePoolBefore += 1;
        expect(poolProduct(state) >= productAtQuote).toBe(true);
      }
      expect(Math.min(bought.YES, bought.NO)).toBeLessThanOrEqual(spent);
      if (buys > 1) windowsWithManyBuys += 1;
    }
    // The property is not vacuous: windows with several buys exist, and some buys do lower y x n against the pool before them.
    expect(windowsWithManyBuys).toBeGreaterThan(100);
    expect(buysBelowThePoolBefore).toBeGreaterThan(0);
  });

  it("pins the example: 1-credit YES buys against one quote of 1000 credits at 0.01 lower y x n against the pool just before them, never below the quote's", () => {
    let state = funded(1000, 10_000);
    let offers: readonly Offer[] = computeOffers(state, DEFAULTS);
    const productAtQuote = poolProduct(state);
    const lowering: number[] = [];
    for (let buy = 1; buy <= 12; buy += 1) {
      const before = poolProduct(state);
      const result = buyResting(state, offers, "YES", 1);
      expect(result).not.toBeNull();
      ({ state, offers } = result!);
      if (poolProduct(state) < before) lowering.push(buy);
      expect(poolProduct(state) >= productAtQuote).toBe(true);
    }
    // The per-fill reading ("every fill pays at least what the curve asks, y x n never falls") is false; the quote's k holds.
    expect(lowering[0]).toBe(6);
    expect(lowering.length).toBeGreaterThan(0);
  });

  it("sells no pair below 1 credit to a trader who buys YES level 0 and NO level 0 in turn with a requote between", () => {
    // At the narrowest spread level 0's price meets the top of its segment exactly: the tightest case.
    const narrowest: PricingSettings = { spreadMicro: SPREAD_MICRO_MIN, levels: 3 };
    for (const fundingCredits of [1, 7, 5000, 1_000_000]) {
      for (const p0 of [10_000, 300_000, 500_000, 600_000, 980_000]) {
        for (const wholeLevel of [true, false]) {
          let state = funded(fundingCredits, p0);
          const bought = { YES: 0, NO: 0 };
          let spent = 0;
          for (let cycle = 0; cycle < 200; cycle += 1) {
            for (const side of SIDES) {
              const offers = computeOffers(state, narrowest);
              const best = sortOffers(offers).find((offer) => offer.side === side);
              if (!best) continue;
              const levelCost = costOf(best.sharesMicro, best.priceMicro);
              // The whole level, or the whole credits it absorbs (a part of it, as an order of whole credits buys).
              const fills = wholeLevel
                ? [{ offer: best, shares: best.sharesMicro, cost: levelCost }]
                : levelCost >= MICROS_PER_UNIT
                  ? planBuy(offers, side, Math.floor(levelCost / MICROS_PER_UNIT) * MICROS_PER_UNIT)!
                  : [];
              for (const { offer, shares, cost } of fills) {
                state = { ...state, holdings: fill(state.holdings, offer, shares) };
                bought[side] += shares;
                spent += cost;
              }
            }
            expect(Math.min(bought.YES, bought.NO)).toBeLessThanOrEqual(spent);
          }
        }
      }
    }
  });
});
