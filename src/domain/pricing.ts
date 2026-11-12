import type { Holdings } from "./book.js";
import { DomainError } from "./errors.js";
import { TRADING_DEFAULT_MAX_OFFERS_PER_SIDE } from "./offers.js";
import type { Offer } from "./offers.js";
import { MAX_PRICE_MICRO, MICROS_PER_UNIT, PRICE_STEP_MICRO, ceilToGrid, isMicroQuantity, isPriceMicro } from "./units.js";
import type { Side } from "./units.js";

// The pricing rule of the market maker (plan 6.4 and Q-18; Proposed ADR-057). Pure functions of one book: the bot keeps
// no state, so the same book and settings always give the same offers.
//
// 1. The pool. Credits the bot account holds count as pairs it can create (trading mints a pair from 1 microcredit when
//    a fill needs it), so the curve sees y = YES + credits and n = NO + credits. The creator's starting price balances
//    the pool: of the funding F (F YES + F NO after the funding call), the shares of the side that starts expensive
//    beyond what the starting price allows are held back (H) and never offered; trading returns them to the creator
//    with everything else at settlement. H follows from F and the starting price alone, so a stateless bot finds it
//    again in every book. Pool: y = YES + credits - H_yes, n = NO + credits - H_no.
// 2. The reference price of YES is the constant-product price n / (y + n), rounded half up to a microcredit; NO is
//    1 credit minus it. This is the skew from the holdings: selling YES lowers y and raises n (the payment is credits),
//    so the YES price rises after every YES fill and falls after every NO fill.
// 3. The ladder per side. The cheapest offer is the reference price plus half the spread, rounded up to the 0.01 grid;
//    each further level is one grid step dearer. Level i (from 0) sells what the constant-product curve (y x n = k)
//    sells while its own marginal price moves from reference + i steps to reference + (i+1) steps, rounded down. Levels
//    above 0.99 are dropped (never clamped down), and the sizes of one side together never exceed that side's pool (so
//    never the held-back shares, and never more than the bot account holds plus its credits: trading's backing rule).
// Never below the quote's curve: half the spread is at least one grid step (SPREAD_MICRO_MIN), so level i costs at least
// reference + (i+1) steps, the marginal price of the quote's curve (y x n = k at the quote) at the top of its segment,
// and the sizes add up to no more than that curve sells to there. Fills take the cheapest offer first, so after any
// fills of one quote each side has paid at least what the quote's curve asks for the same shares. With the YES curve
// moving the pool by (a, b) and the NO curve by (d, e), y x n ends at or above (y+a+d)(n+b+e) = k + ae + db >= k
// (a, e <= 0 <= b, d). One fill against offers left resting from earlier fills of the same quote can lower y x n
// against the pool just before it, never below the quote's k. Trading accepts a replacement only on the current trade
// sequence, so each quote starts from the pool as it is, k at the quotes never falls, and a pair bought from the bot
// costs at least 1 credit whatever the order of the fills and the requotes (along the curve a pair costs exactly 1).
// A narrower spread would sell level 0 below the top of its segment, and alternating YES and NO buys across requotes
// would then buy pairs below 1 credit.
// Never crossed: cheapest YES + cheapest NO >= reference + half + (1 - reference) + half >= 1 credit + 2 steps.
// At the edges a side runs out: it has offers only while ceilToGrid(its reference + half) <= 0.99, so at the default
// spread a market at 0.99 has no YES offers and one at 0.98 a single YES level (mirrored at 0.01 and 0.02).

const MICRO = BigInt(MICROS_PER_UNIT);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The lower bound of SPREAD_MICRO: two grid steps (0.02 credits), so half the spread is at least one step and every
 * level is priced at or above the curve's marginal price at the top of its segment (see the header).
 */
export const SPREAD_MICRO_MIN = 2 * PRICE_STEP_MICRO;
/** The upper bound of SPREAD_MICRO (0.20 credits): wider spreads stop being a market. */
export const SPREAD_MICRO_MAX = 200_000;
/**
 * The upper bound of LEVELS (trading's default MAX_OFFERS_PER_SIDE): a ladder of more levels is not wanted. It is not
 * what keeps a list within trading's limit: the levels quoted are min(LEVELS, the book's maxOffersPerSide).
 */
export const LEVELS_MAX = TRADING_DEFAULT_MAX_OFFERS_PER_SIDE;

/** The runtime keys SPREAD_MICRO and LEVELS (config.ts). */
export interface PricingSettings {
  /** Cheapest YES + cheapest NO - 1 credit, at least; SPREAD_MICRO_MIN .. SPREAD_MICRO_MAX. */
  spreadMicro: number;
  /** Offers per side, at most; 1 .. LEVELS_MAX. At most the book's maxOffersPerSide are quoted (`levelsQuoted`). */
  levels: number;
}

export interface PricingInput {
  holdings: Holdings;
  /** The market's funding in microcredits (BotMarket.fundingMicro). */
  fundingMicro: number;
  /** The creator's starting YES price (BotMarket.startingPriceMicro). */
  startingPriceMicro: number;
  /** The most offers per side trading accepts now (BotBook.maxOffersPerSide, its runtime MAX_OFFERS_PER_SIDE). */
  maxOffersPerSide: number;
}

/** The shares of the funding that are never offered (one side is 0). */
export interface HeldBack {
  yesMicro: number;
  noMicro: number;
}

/** What the curve sees; BigInt because holdings plus credits may pass 2^53. */
export interface Pool {
  yesMicro: bigint;
  noMicro: bigint;
}

/** floor(sqrt(n)) for n >= 0, exact (Newton's method from an upper bound). */
export function isqrtFloor(n: bigint): bigint {
  if (n < 0n) throw new DomainError("invalid_input", "The square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/** ceil(sqrt(n)) for n >= 0, exact. */
export function isqrtCeil(n: bigint): bigint {
  const root = isqrtFloor(n);
  return root * root === n ? root : root + 1n;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function requireFunding(fundingMicro: number, startingPriceMicro: number): void {
  if (!isMicroQuantity(fundingMicro) || fundingMicro < 1) throw new DomainError("invalid_input", "fundingMicro must be a positive safe integer", "fundingMicro");
  if (!isPriceMicro(startingPriceMicro)) throw new DomainError("invalid_input", "startingPriceMicro must be a grid price from 10000 to 990000", "startingPriceMicro");
}

/** a / b rounded to the nearest integer, halves up (a >= 0, b > 0). */
const roundDiv = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

/**
 * The held-back shares of a funding F at the starting price p0: p0 above 0.5 keeps F (1 - p0) / p0 YES in the pool,
 * p0 below 0.5 keeps F p0 / (1 - p0) NO, p0 = 0.5 keeps both whole; the kept amount is rounded to the nearest
 * microshare, so the starting pool's price is within half a microcredit of p0 for every funding of at least 1 credit
 * and the reference price (rounded to a microcredit) starts exactly at p0.
 */
export function heldBackOf(fundingMicro: number, startingPriceMicro: number): HeldBack {
  requireFunding(fundingMicro, startingPriceMicro);
  const funding = BigInt(fundingMicro);
  const p0 = BigInt(startingPriceMicro);
  const half = MICRO / 2n;
  if (p0 > half) return { yesMicro: Number(funding - roundDiv(funding * (MICRO - p0), p0)), noMicro: 0 };
  if (p0 < half) return { yesMicro: 0, noMicro: Number(funding - roundDiv(funding * p0, MICRO - p0)) };
  return { yesMicro: 0, noMicro: 0 };
}

function requireHoldings(holdings: Holdings): void {
  for (const field of ["balanceMicro", "yesMicro", "noMicro"] as const) {
    if (!isMicroQuantity(holdings[field])) throw new DomainError("invalid_input", `holdings.${field} must be a non-negative safe integer`, `holdings.${field}`);
  }
}

/** The pool the curve sees: holdings plus credits minus the held-back shares, never below 0. */
export function poolOf(holdings: Holdings, heldBack: HeldBack): Pool {
  requireHoldings(holdings);
  const credits = BigInt(holdings.balanceMicro);
  const yes = BigInt(holdings.yesMicro) + credits - BigInt(heldBack.yesMicro);
  const no = BigInt(holdings.noMicro) + credits - BigInt(heldBack.noMicro);
  return { yesMicro: yes > 0n ? yes : 0n, noMicro: no > 0n ? no : 0n };
}

/** The YES price n / (y + n) in microcredits, rounded half up; null when a side of the pool is empty (no curve). */
export function referencePriceMicro(pool: Pool): number | null {
  if (pool.yesMicro <= 0n || pool.noMicro <= 0n) return null;
  const total = pool.yesMicro + pool.noMicro;
  return Number((2n * pool.noMicro * MICRO + total) / (2n * total));
}

/** The reference YES price of a book, for logs and tests; null when the pool is empty. */
export function referencePriceOf(input: PricingInput): number | null {
  return referencePriceMicro(poolOf(input.holdings, heldBackOf(input.fundingMicro, input.startingPriceMicro)));
}

export function requirePricingSettings(settings: PricingSettings): void {
  const { spreadMicro, levels } = settings;
  if (!Number.isSafeInteger(spreadMicro) || spreadMicro < SPREAD_MICRO_MIN || spreadMicro > SPREAD_MICRO_MAX) {
    throw new DomainError("invalid_input", `spreadMicro must be an integer from ${SPREAD_MICRO_MIN} to ${SPREAD_MICRO_MAX}`, "spreadMicro");
  }
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > LEVELS_MAX) throw new DomainError("invalid_input", `levels must be an integer from 1 to ${LEVELS_MAX}`, "levels");
}

/**
 * The levels per side the bot quotes: min(LEVELS, maxOffersPerSide), so a list never holds more offers per side than
 * trading accepts, whatever its runtime limit is now (it is read again with every book).
 */
export function levelsQuoted(settings: PricingSettings, maxOffersPerSide: number): number {
  requirePricingSettings(settings);
  if (!Number.isSafeInteger(maxOffersPerSide) || maxOffersPerSide < 1) throw new DomainError("invalid_input", "maxOffersPerSide must be a positive integer", "maxOffersPerSide");
  return Math.min(settings.levels, maxOffersPerSide);
}

/**
 * The offers of one side. `own` is the pool of the side sold, `other` the pool of the other side, `referenceMicro` the
 * price of the side sold. Along y x n = k, selling the own side for credits moves the pool to own(c) =
 * sqrt(k (1 - c) / c) and other(c) = sqrt(k c / (1 - c)) at the own side's marginal price c; the shares sold between
 * two prices are the drop of `own` plus the growth of `other` (the payment, minted into pairs). own(c) rounds up and
 * other(c) down, so a level never holds more than the curve gives. The settings are checked here too, because a spread
 * below SPREAD_MICRO_MIN would price level 0 below the curve.
 */
export function sideLadder(side: Side, own: bigint, other: bigint, referenceMicro: number, settings: PricingSettings): Offer[] {
  requirePricingSettings(settings);
  const offers: Offer[] = [];
  if (own <= 0n || other <= 0n) return offers;
  const k = own * other;
  const half = Math.ceil(settings.spreadMicro / 2);
  const firstPrice = ceilToGrid(referenceMicro + half);
  let remaining = own < MAX_SAFE ? own : MAX_SAFE;
  let previousOwn = own;
  let previousOther = other;
  let previousBoundary = referenceMicro;
  for (let level = 0; level < settings.levels; level += 1) {
    const priceMicro = firstPrice + level * PRICE_STEP_MICRO;
    if (priceMicro > MAX_PRICE_MICRO) break;
    const boundary = Math.min(referenceMicro + (level + 1) * PRICE_STEP_MICRO, MAX_PRICE_MICRO);
    if (boundary <= previousBoundary) break;
    const c = BigInt(boundary);
    const ownAt = isqrtCeil(ceilDiv(k * (MICRO - c), c));
    const otherAt = isqrtFloor((k * c) / (MICRO - c));
    let shares = previousOwn - ownAt + (otherAt - previousOther);
    if (shares > remaining) shares = remaining;
    if (shares > 0n) {
      offers.push({ side, priceMicro, sharesMicro: Number(shares) });
      remaining -= shares;
    }
    previousOwn = ownAt;
    previousOther = otherAt;
    previousBoundary = boundary;
    if (remaining === 0n) break;
  }
  return offers;
}

/**
 * The whole offer list of one book: YES ascending, then NO ascending, at most min(LEVELS, input.maxOffersPerSide)
 * offers per side. Empty when the pool has an empty side. Throws DomainError only for input outside trading's contract
 * or settings outside their ranges.
 */
export function computeOffers(input: PricingInput, settings: PricingSettings): Offer[] {
  const quoted: PricingSettings = { ...settings, levels: levelsQuoted(settings, input.maxOffersPerSide) };
  const pool = poolOf(input.holdings, heldBackOf(input.fundingMicro, input.startingPriceMicro));
  const reference = referencePriceMicro(pool);
  if (reference === null) return [];
  return [
    ...sideLadder("YES", pool.yesMicro, pool.noMicro, reference, quoted),
    ...sideLadder("NO", pool.noMicro, pool.yesMicro, MICROS_PER_UNIT - reference, quoted),
  ];
}
