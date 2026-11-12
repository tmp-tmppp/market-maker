import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { BotBook, BotMarket, Holdings } from "../../src/domain/book.js";
import { TRADING_DEFAULT_MAX_OFFERS_PER_SIDE } from "../../src/domain/offers.js";
import type { Offer } from "../../src/domain/offers.js";
import { MICROS_PER_UNIT } from "../../src/domain/units.js";
import type { Clock, Delay, Logger, QuotingSettings, QuotingSettingsSource, Random } from "../../src/usecases/ports.js";

// Test doubles shared by the domain, use-case and adapter tests.

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";
export const MARKET_1 = "018f3c1e-7a00-7000-8000-000000000101";
export const MARKET_2 = "018f3c1e-7a00-7000-8000-000000000102";
export const EVENT_1 = "018f3c1e-7a00-7000-8000-000000000e01";

export class TestClock implements Clock {
  constructor(private current = new Date("2026-11-01T10:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string }> = [];
  debug(fields: object, message: string): void {
    this.lines.push({ level: "debug", fields, message });
  }
  info(fields: object, message: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message: string): void {
    this.lines.push({ level: "error", fields, message });
  }
  messages(level?: string): string[] {
    return this.lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
  }
}

/** Quoting settings a test can change between calls (the runtime configuration, ADR-037). */
export class TestSettings implements QuotingSettingsSource {
  settings: QuotingSettings = { ...DEFAULT_RUNTIME_SETTINGS.quoting };
  current(): QuotingSettings {
    return this.settings;
  }
}

/** Resolves every wait at once and records it. */
export class InstantDelay implements Delay {
  readonly waits: number[] = [];
  sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    return Promise.resolve();
  }
}

/** A fixed value in [0, 1) (0.5 = no jitter). */
export class FixedRandom implements Random {
  constructor(private readonly value = 0.5) {}
  next(): number {
    return this.value;
  }
}

/** A seeded pseudo-random generator (mulberry32) for the property tests: the same seed gives the same books. */
export class SeededRandom implements Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer from min to max, both included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

export const credits = (amount: number): number => amount * MICROS_PER_UNIT;

export interface BookOptions {
  marketId?: string;
  tenantId?: string;
  status?: BotMarket["status"];
  /** Whole credits; default 5000. Null = not funded. */
  fundingCredits?: number | null;
  /** Default 500000 (0.50). Null = MarketOpened not processed yet. */
  startingPriceMicro?: number | null;
  /** Default: the funding as pairs and no credits. */
  holdings?: Holdings;
  offers?: Offer[];
  tradeSequence?: number;
  offersPricedOnSequence?: number | null;
  closeTime?: Date | null;
  /** trading's runtime MAX_OFFERS_PER_SIDE as the book reports it; default 10 (its default). */
  maxOffersPerSide?: number;
}

/** A book as trading returns it right after the funding call and MarketOpened, unless the options say otherwise. */
export function bookOf(options: BookOptions = {}): BotBook {
  const fundingCredits = options.fundingCredits === undefined ? 5000 : options.fundingCredits;
  const fundingMicro = fundingCredits === null ? null : credits(fundingCredits);
  const tradeSequence = options.tradeSequence ?? 0;
  const offers = options.offers ?? [];
  return {
    market: {
      marketId: options.marketId ?? MARKET_1,
      tenantId: options.tenantId ?? TENANT_A,
      status: options.status ?? "open",
      version: 1,
      closeTime: options.closeTime === undefined ? new Date("2026-12-01T10:00:00.000Z") : options.closeTime,
      startingPriceMicro: options.startingPriceMicro === undefined ? 500_000 : options.startingPriceMicro,
      fundingMicro,
      tradeSequence,
    },
    holdings: options.holdings ?? { balanceMicro: 0, yesMicro: fundingMicro ?? 0, noMicro: fundingMicro ?? 0 },
    offers,
    tradeSequence,
    offersPricedOnSequence: options.offersPricedOnSequence === undefined ? (offers.length > 0 ? tradeSequence : null) : options.offersPricedOnSequence,
    maxOffersPerSide: options.maxOffersPerSide ?? TRADING_DEFAULT_MAX_OFFERS_PER_SIDE,
  };
}
