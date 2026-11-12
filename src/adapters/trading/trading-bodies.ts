import { MARKET_STATUSES } from "../../domain/book.js";
import type { BotBook, BotMarket, Holdings, MarketStatus } from "../../domain/book.js";
import type { Offer } from "../../domain/offers.js";
import { isPriceMicro, isSide } from "../../domain/units.js";
import { TradingContractViolation } from "../../usecases/errors.js";
import type { OpenMarketsPage } from "../../usecases/ports.js";

// The answers of trading's internal API, parsed strictly (contracts/outgoing/trading-bot.openapi.yaml; the copy of
// trading's own file is in contracts/external). A body that breaks the contract is a TradingContractViolation that names
// the field and what is wrong with it, never the value or the body: a violation reaches the logs and the nak of a
// message, and a body may hold anything. Unknown extra fields are ignored (a new optional field of trading must not
// stop the bot). Ids are returned in lower case, as the event reader does, so a market of an event and of a book compare.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RFC 3339 date-time with a zone, as OpenAPI's `format: date-time` means it. */
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** The most offers per side trading may report (its MAX_OFFERS_PER_SIDE is 1..50). */
const MAX_OFFERS_PER_SIDE_LIMIT = 50;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function violation(path: string, wrong: string): never {
  throw new TradingContractViolation(`${path === "" ? "the body" : path} ${wrong}`);
}

const at = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) return violation(path, "is not a JSON object");
  return value;
}

/** The value of a required field: a missing field is named as missing, whatever its type would have been. */
function required(parent: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(parent, key)) return violation(at(path, key), "is missing");
  return parent[key];
}

function uuidAt(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return violation(path, "is not a UUID");
  return value.toLowerCase();
}

function integerAt(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return violation(path, "is not a safe integer");
  if (value < min || value > max) return violation(path, `is outside ${min}..${max}`);
  return value;
}

function dateTimeAt(value: unknown, path: string): Date {
  if (typeof value !== "string" || !DATE_TIME_PATTERN.test(value)) return violation(path, "is not an RFC 3339 date-time with a zone");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return violation(path, "is not a real date-time");
  return date;
}

const nullable = <T>(value: unknown, read: (present: unknown) => T): T | null => (value === null ? null : read(value));

function statusAt(value: unknown, path: string): MarketStatus {
  const status = MARKET_STATUSES.find((known) => known === value);
  if (status === undefined) return violation(path, `is not one of ${MARKET_STATUSES.join(", ")}`);
  return status;
}

function readMarket(value: unknown, path: string): BotMarket {
  const body = recordAt(value, path);
  const field = (key: string): unknown => required(body, key, path);
  return {
    marketId: uuidAt(field("marketId"), at(path, "marketId")),
    tenantId: uuidAt(field("tenantId"), at(path, "tenantId")),
    status: statusAt(field("status"), at(path, "status")),
    version: integerAt(field("version"), at(path, "version"), 0),
    closeTime: nullable(field("closeTime"), (present) => dateTimeAt(present, at(path, "closeTime"))),
    startingPriceMicro: nullable(field("startingPriceMicro"), (present) => {
      if (!isPriceMicro(present)) return violation(at(path, "startingPriceMicro"), "is not a grid price (10000..990000, a multiple of 10000) or null");
      return present;
    }),
    fundingMicro: nullable(field("fundingMicro"), (present) => integerAt(present, at(path, "fundingMicro"), 1)),
    tradeSequence: integerAt(field("tradeSequence"), at(path, "tradeSequence"), 0),
  };
}

function readHoldings(value: unknown, path: string): Holdings {
  const body = recordAt(value, path);
  const field = (key: string): number => integerAt(required(body, key, path), at(path, key), 0);
  return { balanceMicro: field("balanceMicro"), yesMicro: field("yesMicro"), noMicro: field("noMicro") };
}

function readOffer(value: unknown, path: string): Offer {
  const body = recordAt(value, path);
  const side = required(body, "side", path);
  if (!isSide(side)) return violation(at(path, "side"), "is not YES or NO");
  const priceMicro = required(body, "priceMicro", path);
  if (!isPriceMicro(priceMicro)) return violation(at(path, "priceMicro"), "is not a grid price (10000..990000, a multiple of 10000)");
  return { side, priceMicro, sharesMicro: integerAt(required(body, "sharesMicro", path), at(path, "sharesMicro"), 1) };
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return violation(path, "is not an array");
  return value;
}

/** One BotMarket (a list item). */
export function parseBotMarket(value: unknown): BotMarket {
  return readMarket(value, "");
}

/** The answer of GET bot-book and of a successful PUT bot-orders. */
export function parseBotBook(value: unknown): BotBook {
  const body = recordAt(value, "");
  const field = (key: string): unknown => required(body, key, "");
  const offersPricedOnSequence = nullable(field("offersPricedOnSequence"), (present) => integerAt(present, "offersPricedOnSequence", 0));
  return {
    market: readMarket(field("market"), "market"),
    holdings: readHoldings(field("holdings"), "holdings"),
    offers: arrayAt(field("offers"), "offers").map((offer, index) => readOffer(offer, `offers[${index}]`)),
    tradeSequence: integerAt(field("tradeSequence"), "tradeSequence", 0),
    offersPricedOnSequence,
    maxOffersPerSide: integerAt(field("maxOffersPerSide"), "maxOffersPerSide", 1, MAX_OFFERS_PER_SIDE_LIMIT),
  };
}

/** One page of GET /v1/internal/markets. */
export function parseOpenMarketsPage(value: unknown): OpenMarketsPage {
  const body = recordAt(value, "");
  const items = arrayAt(required(body, "items", ""), "items").map((item, index) => readMarket(item, `items[${index}]`));
  const nextCursor = nullable(required(body, "nextCursor", ""), (present) => {
    if (typeof present !== "string" || present === "") return violation("nextCursor", "is not a non-empty string or null");
    return present;
  });
  return { items, nextCursor };
}

/** What a problem body (RFC 9457) tells the client; every part is null when it is absent or unusable. */
export interface ProblemInfo {
  /** The stable `code`: lower-case words with underscores. */
  code: string | null;
  /** `detail`, else `title`, cut to PROBLEM_DETAIL_MAX_LENGTH: it goes into logs. */
  detail: string | null;
  /** `tradeSequence` of a 409 stale_sequence. */
  tradeSequence: number | null;
}

export const PROBLEM_DETAIL_MAX_LENGTH = 200;
/** Only this much of a body is looked at. A longer one is not a problem body of trading, so it gives nulls. */
const PROBLEM_TEXT_MAX_LENGTH = 8192;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Reads the problem details of an error answer from its text. An unreadable text gives nulls, never an error. */
export function problemOf(text: string): ProblemInfo {
  const none: ProblemInfo = { code: null, detail: null, tradeSequence: null };
  if (text.length > PROBLEM_TEXT_MAX_LENGTH) return none;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isRecord(body)) return none;
  const words = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, PROBLEM_DETAIL_MAX_LENGTH) : null);
  const code = body["code"];
  const sequence = body["tradeSequence"];
  return {
    code: typeof code === "string" && CODE_PATTERN.test(code) ? code : null,
    detail: words(body["detail"]) ?? words(body["title"]),
    tradeSequence: typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null,
  };
}
