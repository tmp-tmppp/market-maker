// Units of trading's internal API (Proposed ADR-055, exact integer micro-units), the subset the market maker needs.
//
// Every quantity is an exact integer: 1 credit = 1 000 000 microcredits, 1 share = 1 000 000 microshares, and a winning
// share pays 1 credit, so one pair (1 YES + 1 NO microshare) is worth exactly 1 microcredit. Prices are microcredits per
// share from 10 000 (0.01) to 990 000 (0.99) in steps of 10 000. No floating point touches a quantity: the pricing
// functions compute with BigInt (src/domain/pricing.ts) and hand out safe integers.

export const MICROS_PER_UNIT = 1_000_000;

export const PRICE_STEP_MICRO = 10_000;
export const MIN_PRICE_MICRO = 10_000;
export const MAX_PRICE_MICRO = 990_000;

export const SIDES = ["YES", "NO"] as const;
export type Side = (typeof SIDES)[number];

export function isSide(value: unknown): value is Side {
  return value === "YES" || value === "NO";
}

export function otherSide(side: Side): Side {
  return side === "YES" ? "NO" : "YES";
}

/** A safe, non-negative integer: what every micro quantity of a holding or an offer is. */
export function isMicroQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A price trading accepts in an offer: 10 000 .. 990 000, a multiple of 10 000. */
export function isPriceMicro(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_PRICE_MICRO &&
    value <= MAX_PRICE_MICRO &&
    value % PRICE_STEP_MICRO === 0
  );
}

/**
 * The smallest grid price that is at least `micro` and at least MIN_PRICE_MICRO. It may exceed MAX_PRICE_MICRO: the
 * caller drops such a level instead of selling below the price it computed.
 */
export function ceilToGrid(micro: number): number {
  const steps = Math.ceil(Math.max(micro, MIN_PRICE_MICRO) / PRICE_STEP_MICRO);
  return steps * PRICE_STEP_MICRO;
}
