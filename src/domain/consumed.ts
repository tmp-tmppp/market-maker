// The events the market maker consumes, read as notifications (EP-1, ADR-041): only CloudEvent attributes are used
// (type, id, time, tenantid, correlationid and the market from `subject` = "market/<marketId>"), never a business field of
// `data`, because every quote run reads the bot's book from trading again. The one exception is TradeExecuted's
// `data.tradeSequence`, read for the logs only: no decision depends on it. Unknown fields and unknown types are ignored
// (a new optional field never breaks the bot); a malformed event is "ignored", which the consumer logs and acknowledges
// (a poison message must not block the stream).
// markets: contracts/external/markets-asyncapi.yaml; trading: contracts/external/trading-asyncapi.yaml.

export const MARKET_OPENED_TYPE = "si.chance.markets.MarketOpened.v1";
export const MARKET_CLOSED_TYPE = "si.chance.markets.MarketClosed.v1";
export const MARKET_RESOLVED_TYPE = "si.chance.markets.MarketResolved.v1";
export const TRADE_EXECUTED_TYPE = "si.chance.trading.TradeExecuted.v1";

export const CONSUMED_TYPES = [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE] as const;

export type MarketNoticeKind = "market_opened" | "market_closed" | "market_resolved" | "trade_executed";

const KIND_OF_TYPE: Record<(typeof CONSUMED_TYPES)[number], MarketNoticeKind> = {
  [MARKET_OPENED_TYPE]: "market_opened",
  [MARKET_CLOSED_TYPE]: "market_closed",
  [MARKET_RESOLVED_TYPE]: "market_resolved",
  [TRADE_EXECUTED_TYPE]: "trade_executed",
};

/** One consumed event, reduced to its envelope. */
export interface MarketNotice {
  kind: MarketNoticeKind;
  /** The CloudEvent id (lower case), for the logs. */
  eventId: string;
  eventType: string;
  /** From "tenantid", lower case. trading takes the tenant from the market, so this is for the logs only. */
  tenantId: string;
  /** From "subject" ("market/<marketId>"), lower case. */
  marketId: string;
  /** TradeExecuted's data.tradeSequence when it is a non-negative safe integer, else null; for the logs only. */
  tradeSequence: number | null;
  /** From "correlationid"; null when the event has none (the bot then uses the event id). */
  correlationId: string | null;
  /**
   * From "time" (required by both publishers); null when it is missing or not a date-time, and such an event is never
   * skipped as older than the process start (support.ts `predatesStart`).
   */
  time: Date | null;
}

/** Not an event the bot acts on, or a malformed one: logged and acknowledged. */
export interface IgnoredEvent {
  kind: "ignored";
  reason: string;
  eventId: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const SUBJECT_PATTERN =/^market\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isConsumedType = (value: unknown): value is (typeof CONSUMED_TYPES)[number] => (CONSUMED_TYPES as readonly unknown[]).includes(value);

/** A message of the MARKETS or the TRADING stream, already parsed from JSON. */
export function readMarketNotice(body: unknown): MarketNotice | IgnoredEvent {
  if (!isObject(body)) return { kind: "ignored", reason: "The message is not a JSON object", eventId: null };
  const eventId = typeof body["id"] === "string" && UUID_PATTERN.test(body["id"]) ? body["id"].toLowerCase() : null;
  if (body["specversion"] !== "1.0") return { kind: "ignored", reason: "The message is not a CloudEvent 1.0", eventId };
  const type = body["type"];
  if (!isConsumedType(type)) return { kind: "ignored", reason: `Unknown event type ${String(type)}`, eventId };
  if (eventId === null) return { kind: "ignored", reason: "The event id is missing or not a UUID", eventId: null };
  const tenantId = body["tenantid"];
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) return { kind: "ignored", reason: "The tenantid attribute is missing or not a UUID", eventId };
  const subject = typeof body["subject"] === "string" ? SUBJECT_PATTERN.exec(body["subject"]) : null;
  const marketId = subject?.[1];
  if (marketId === undefined) return { kind: "ignored", reason: "The subject attribute is not market/<marketId>", eventId };

  const kind = KIND_OF_TYPE[type];
  let tradeSequence: number | null = null;
  if (kind === "trade_executed" && isObject(body["data"])) {
    const value = body["data"]["tradeSequence"];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) tradeSequence = value;
  }
  const correlationId = typeof body["correlationid"] === "string" && body["correlationid"] !== "" ? body["correlationid"] : null;
  return { kind, eventId, eventType: type, tenantId: tenantId.toLowerCase(), marketId: marketId.toLowerCase(), tradeSequence, correlationId, time: timeOf(body["time"]) };
}

/** An RFC 3339 date-time with a zone (Z or an offset) as a Date; anything else is null. */
function timeOf(value: unknown): Date | null {
  if (typeof value !== "string" || !DATE_TIME_PATTERN.test(value)) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}
