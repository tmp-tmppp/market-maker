import { readMarketNotice } from "../../domain/consumed.js";
import { TradingUnavailable } from "../../usecases/errors.js";
import type { Logger } from "../../usecases/ports.js";
import { wantsRedelivery } from "../../usecases/support.js";
import type { EventOutcome, ReactToMarketEventUseCase } from "../../usecases/use-cases.js";

// What a consumer does with one message, without any NATS type, so that the rules are unit-tested (EP-1, ADR-041). The
// bot keeps no inbox: the reaction is idempotent (it reads the book again and sends a list priced on the current
// sequence), so a duplicate or reordered event costs one read. The consumer acknowledges a message after the handler
// returned "ack", which is after the quote run ended; "nak" asks for a new delivery after a delay, and the delivery
// number `giveUpAfter` ends the redelivery with an error log and an ack (nothing is lost: the periodic check quotes the
// market within RECHECK_INTERVAL_MS).

/** What the consumer does with the message: acknowledge it, or ask the broker to deliver it again later. */
export type HandleResult = { kind: "ack" } | { kind: "nak"; reason: string };

const ACK: HandleResult = { kind: "ack" };

const MAX_REASON_LENGTH = 500;

/** The error code and message of a failure, for the log and the next delivery: never a token or a body. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, MAX_REASON_LENGTH);
  // TradingUnavailable and TradingContractViolation carry a stable `code`; the rest has its name.
  const { code } = error as Error & { code?: unknown };
  const label = typeof code === "string" && code !== "" ? code : error.name;
  return `${label}: ${error.message}`.slice(0, MAX_REASON_LENGTH);
}

function parseBody(data: Uint8Array): { ok: true; body: unknown } | { ok: false } {
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(data)) as unknown };
  } catch {
    return { ok: false };
  }
}

type Level = "debug" | "info" | "warn" | "error";

/** How loudly the end of one event is logged: what needs a human is loud, the routine is quiet. */
function levelOf(outcome: EventOutcome): Level {
  switch (outcome.kind) {
    case "refused":
      return "error";
    case "contended":
    case "not_found":
      return "warn";
    case "skipped":
    case "unchanged":
    case "disabled":
      return "debug";
    case "quoted":
    case "stopped":
    case "not_ready":
    case "stop_notice":
      return "info";
  }
}

/** The extra fields of an outcome worth a line: the reason of a stop or a skip, trading's code of a refusal. */
function detailOf(outcome: EventOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "stopped":
    case "not_ready":
    case "skipped":
      return { reason: outcome.reason };
    case "stop_notice":
      return { event: outcome.event };
    case "refused":
      return { status: outcome.status, code: outcome.code };
    case "contended":
      return { attempts: outcome.attempts };
    default:
      return {};
  }
}

/**
 * One message of the MARKETS or the TRADING stream (the consumers' filters let only MarketOpened, MarketClosed,
 * MarketResolved and TradeExecuted through, but a filter is no guarantee of a well-formed body).
 *  - A message that is not JSON, not a CloudEvent 1.0, of another type or malformed: a log line and "ack". A poison
 *    message must never block the consumer, and redelivering it would change nothing.
 *  - An event the reaction ends with "not_ready" (a funded copy whose starting price trading has not recorded yet):
 *    "nak", because a later delivery may find it ready.
 *  - Every other outcome, also "contended" (each trade behind the stale answers publishes its own event) and "refused"
 *    (a defect: repeating the same list would change nothing): "ack", logged at the level the outcome deserves.
 *  - An error of the reaction (TradingUnavailable, TradingContractViolation): "nak" with its code and message, so the
 *    broker delivers the event again after a delay.
 */
export async function handleMarketMessage(data: Uint8Array, react: ReactToMarketEventUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message is not JSON; it is acknowledged and skipped");
    return ACK;
  }
  const notice = readMarketNotice(parsed.body);
  if (notice.kind === "ignored") {
    const fields = { eventId: notice.eventId, reason: notice.reason };
    // A well-formed event of a type the bot does not act on is normal (an unexpected publisher change); anything else wrong is a warning.
    if (notice.reason.startsWith("Unknown event type")) logger.info(fields, "A message is not an event the market maker acts on; it is acknowledged and skipped");
    else logger.warn(fields, "A message is not a usable event; it is acknowledged and skipped");
    return ACK;
  }
  const fields = {
    marketId: notice.marketId,
    tenantId: notice.tenantId,
    eventId: notice.eventId,
    eventType: notice.eventType,
    correlationId: notice.correlationId,
    tradeSequence: notice.tradeSequence,
  };
  let outcome: EventOutcome;
  try {
    outcome = await react.execute(notice);
  } catch (error) {
    // trading cannot answer now (or answered outside its contract): the next delivery repeats the whole quote run.
    const level: Level = error instanceof TradingUnavailable ? "warn" : "error";
    logger[level]({ ...fields, err: error }, "A market event could not be processed; it will be delivered again");
    return { kind: "nak", reason: describeError(error) };
  }
  logger[levelOf(outcome)]({ ...fields, outcome: outcome.kind, ...detailOf(outcome) }, "A market event was handled");
  if (wantsRedelivery(outcome)) return { kind: "nak", reason: outcome.kind };
  return ACK;
}

/** The part of a JetStream message the settle step needs (a `JsMsg` fits). */
export interface SettleableMessage {
  /** The stream sequence: unique per stream, known even for a body that is not JSON. */
  seq: number;
  subject: string;
  data: Uint8Array;
  info: { deliveryCount: number };
  ack(): void;
  nak(millis?: number): void;
}

export interface SettleOptions {
  /** Deliveries after which a failing message is given up (GIVE_UP_AFTER_DELIVERIES). */
  giveUpAfter: number;
  nakDelayMs: number;
  logger: Logger;
  /** The stream the message came from: MARKETS or TRADING, for the log. */
  stream: string;
}

/**
 * Applies a handler's result to the message. "ack" acknowledges it. A "nak" asks for a new delivery after `nakDelayMs`,
 * unless this was already delivery number `giveUpAfter` or later: then the failure is logged as an error and the message
 * is acknowledged, so one failing event never holds back the others (the bot has no state to lose: the periodic check
 * quotes the market again). The body is never logged.
 */
export function settleMessage(message: SettleableMessage, result: HandleResult, options: SettleOptions): "acked" | "naked" | "given_up" {
  if (result.kind === "ack") {
    message.ack();
    return "acked";
  }
  const deliveries = message.info.deliveryCount;
  if (deliveries >= options.giveUpAfter) {
    options.logger.error(
      { stream: options.stream, streamSequence: message.seq, subject: message.subject, reason: result.reason, deliveries },
      "An event failed too many deliveries; it was given up and acknowledged (the periodic check quotes its market)",
    );
    message.ack();
    return "given_up";
  }
  message.nak(options.nakDelayMs);
  return "naked";
}
