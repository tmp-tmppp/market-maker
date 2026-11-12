import type { Holdings } from "./book.js";
import { MICROS_PER_UNIT, SIDES, isMicroQuantity, isPriceMicro } from "./units.js";
import type { Side } from "./units.js";

// The offer list the bot sends to trading in one replacement (PUT bot-orders) and the rules trading enforces on it
// (trading's contracts/internal.openapi.yaml). The bot checks the same rules before it sends a list, so a list it
// computed and trading refuses is a defect on one of the two sides, never a normal outcome.

/** One resting limit order of the bot: it sells `sharesMicro` of `side` at `priceMicro` per share. */
export interface Offer {
  side: Side;
  priceMicro: number;
  sharesMicro: number;
}

/**
 * trading's default MAX_OFFERS_PER_SIDE (a runtime key of trading, 1..50). The bot does not rely on it: every book
 * carries trading's current value (`BotBook.maxOffersPerSide`) and the bot quotes at most that many levels per side
 * (pricing.ts, `levelsQuoted`). The default only bounds its own LEVELS (config.ts).
 */
export const TRADING_DEFAULT_MAX_OFFERS_PER_SIDE = 10;

/** YES before NO, each side by ascending price: the order the bot sends and compares in. */
export function sortOffers(offers: readonly Offer[]): Offer[] {
  return [...offers].sort((a, b) => (a.side === b.side ? a.priceMicro - b.priceMicro : a.side === "YES" ? -1 : 1));
}

/** True when both lists hold the same offers, in any order. */
export function sameOffers(a: readonly Offer[], b: readonly Offer[]): boolean {
  if (a.length !== b.length) return false;
  const left = sortOffers(a);
  const right = sortOffers(b);
  return left.every((offer, index) => {
    const other = right[index];
    return other !== undefined && other.side === offer.side && other.priceMicro === offer.priceMicro && other.sharesMicro === offer.sharesMicro;
  });
}

/** The microshares offered per side, as BigInt (a sum of safe integers may pass 2^53). */
export function offeredBySide(offers: readonly Offer[]): Record<Side, bigint> {
  const total: Record<Side, bigint> = { YES: 0n, NO: 0n };
  for (const offer of offers) total[offer.side] += BigInt(offer.sharesMicro);
  return total;
}

/** The cheapest offer of a side, or null when the side has none. */
export function bestPriceMicro(offers: readonly Offer[], side: Side): number | null {
  let best: number | null = null;
  for (const offer of offers) if (offer.side === side && (best === null || offer.priceMicro < best)) best = offer.priceMicro;
  return best;
}

/**
 * Every rule of trading's PUT bot-orders that `offers` breaks, as readable lines (empty = trading accepts the list):
 * prices on the grid within 0.01 .. 0.99, positive safe sizes, one offer per price and side, at most `maxPerSide` per
 * side, not crossed (cheapest YES + cheapest NO >= 1 credit) and backed (per side, offered <= that holding + the
 * credits, which can each become a pair).
 */
export function offerViolations(offers: readonly Offer[], holdings: Holdings, maxPerSide: number): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const count: Record<Side, number> = { YES: 0, NO: 0 };
  for (const offer of offers) {
    if (!isPriceMicro(offer.priceMicro)) problems.push(`${offer.side} price ${String(offer.priceMicro)} is off the grid or outside 10000..990000`);
    if (!isMicroQuantity(offer.sharesMicro) || offer.sharesMicro < 1) problems.push(`${offer.side} offer at ${offer.priceMicro} has no positive safe size`);
    const key = `${offer.side}/${offer.priceMicro}`;
    if (seen.has(key)) problems.push(`${offer.side} has two offers at ${offer.priceMicro}`);
    seen.add(key);
    count[offer.side] += 1;
  }
  for (const side of SIDES) if (count[side] > maxPerSide) problems.push(`${side} has ${count[side]} offers, more than ${maxPerSide}`);

  const bestYes = bestPriceMicro(offers, "YES");
  const bestNo = bestPriceMicro(offers, "NO");
  if (bestYes !== null && bestNo !== null && bestYes + bestNo < MICROS_PER_UNIT) problems.push(`crossed: cheapest YES ${bestYes} + cheapest NO ${bestNo} < 1000000`);

  const offered = offeredBySide(offers);
  const credits = BigInt(holdings.balanceMicro);
  const held: Record<Side, bigint> = { YES: BigInt(holdings.yesMicro), NO: BigInt(holdings.noMicro) };
  for (const side of SIDES) {
    if (offered[side] > held[side] + credits) problems.push(`${side} offers ${offered[side]} microshares, more than the ${held[side] + credits} the bot account can deliver`);
  }
  return problems;
}
