import { describe, expect, it } from "vitest";
import { quotingStateOf } from "../../src/domain/book.js";
import { bestPriceMicro, offerViolations, offeredBySide, sameOffers, sortOffers } from "../../src/domain/offers.js";
import type { Offer } from "../../src/domain/offers.js";
import { ceilToGrid, isPriceMicro, otherSide } from "../../src/domain/units.js";
import { bookOf, credits } from "../support/fakes.js";

const yes = (priceMicro: number, sharesMicro = credits(10)): Offer => ({ side: "YES", priceMicro, sharesMicro });
const no = (priceMicro: number, sharesMicro = credits(10)): Offer => ({ side: "NO", priceMicro, sharesMicro });
const holdings = { balanceMicro: credits(5), yesMicro: credits(20), noMicro: credits(20) };

describe("units", () => {
  it("knows the price grid", () => {
    expect(isPriceMicro(10_000)).toBe(true);
    expect(isPriceMicro(990_000)).toBe(true);
    expect(isPriceMicro(0)).toBe(false);
    expect(isPriceMicro(1_000_000)).toBe(false);
    expect(isPriceMicro(505_000)).toBe(false);
    expect(ceilToGrid(0)).toBe(10_000);
    expect(ceilToGrid(510_000)).toBe(510_000);
    expect(ceilToGrid(510_001)).toBe(520_000);
    expect(ceilToGrid(995_000)).toBe(1_000_000);
    expect(otherSide("YES")).toBe("NO");
  });
});

describe("offer lists", () => {
  it("sorts YES before NO, each by ascending price, and compares in any order", () => {
    const list = [no(400_000), yes(620_000), no(390_000), yes(610_000)];
    expect(sortOffers(list).map((o) => `${o.side}${o.priceMicro}`)).toEqual(["YES610000", "YES620000", "NO390000", "NO400000"]);
    expect(sameOffers(list, sortOffers(list))).toBe(true);
    expect(sameOffers(list, list.slice(1))).toBe(false);
    expect(sameOffers([yes(610_000, 1)], [yes(610_000, 2)])).toBe(false);
    expect(bestPriceMicro(list, "NO")).toBe(390_000);
    expect(bestPriceMicro([], "YES")).toBeNull();
    expect(offeredBySide(list)).toEqual({ YES: BigInt(credits(20)), NO: BigInt(credits(20)) });
  });

  it("accepts what trading accepts", () => {
    expect(offerViolations([yes(610_000), no(400_000)], holdings, 10)).toEqual([]);
    expect(offerViolations([], holdings, 1)).toEqual([]);
  });

  it("names every rule trading would refuse", () => {
    expect(offerViolations([yes(605_000)], holdings, 10)).toHaveLength(1);
    expect(offerViolations([yes(610_000, 0)], holdings, 10)).toHaveLength(1);
    expect(offerViolations([yes(610_000), yes(610_000)], holdings, 10)).toHaveLength(1);
    expect(offerViolations([yes(610_000), yes(620_000)], holdings, 1)).toHaveLength(1);
    expect(offerViolations([yes(500_000), no(490_000)], holdings, 10)).toEqual([expect.stringContaining("crossed")]);
    expect(offerViolations([yes(610_000, credits(26))], holdings, 10)).toEqual([expect.stringContaining("more than")]);
    expect(offerViolations([yes(610_000, credits(25))], holdings, 10)).toEqual([]);
  });
});

describe("quotingStateOf", () => {
  const now = new Date("2026-11-01T10:00:00.000Z");

  it("quotes an open or a funded market with a starting price", () => {
    expect(quotingStateOf(bookOf(), now)).toEqual({ kind: "quote", fundingMicro: credits(5000), startingPriceMicro: 500_000, maxOffersPerSide: 10 });
    expect(quotingStateOf(bookOf({ status: "funded" }), now).kind).toBe("quote");
  });

  it("carries the offer limit per side the book reports, as trading changed it", () => {
    expect(quotingStateOf(bookOf({ maxOffersPerSide: 4 }), now)).toMatchObject({ kind: "quote", maxOffersPerSide: 4 });
    expect(quotingStateOf(bookOf({ maxOffersPerSide: 50 }), now)).toMatchObject({ kind: "quote", maxOffersPerSide: 50 });
  });

  it("stops on a closed, resolved or past-close market", () => {
    expect(quotingStateOf(bookOf({ status: "closed" }), now)).toEqual({ kind: "stopped", reason: "closed" });
    expect(quotingStateOf(bookOf({ status: "resolved" }), now)).toEqual({ kind: "stopped", reason: "resolved" });
    expect(quotingStateOf(bookOf({ closeTime: now }), now)).toEqual({ kind: "stopped", reason: "past_close_time" });
  });

  it("waits for the funding and for the starting price", () => {
    expect(quotingStateOf(bookOf({ fundingCredits: null }), now)).toEqual({ kind: "not_ready", reason: "not_funded" });
    expect(quotingStateOf(bookOf({ status: "funded", startingPriceMicro: null, closeTime: null }), now)).toEqual({ kind: "not_ready", reason: "no_starting_price" });
  });
});
