import { describe, expect, it } from "vitest";
import { describeError, handleMarketMessage, settleMessage } from "../../src/adapters/nats/message-handlers.js";
import type { HandleResult, SettleableMessage } from "../../src/adapters/nats/message-handlers.js";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE } from "../../src/domain/consumed.js";
import type { MarketNotice } from "../../src/domain/consumed.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import type { EventOutcome, ReactToMarketEventUseCase } from "../../src/usecases/use-cases.js";
import { EVENT_1, MARKET_1, RecordingLogger, TENANT_A } from "../support/fakes.js";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** A CloudEvent of the MARKETS or TRADING stream; the overrides replace or (with undefined) drop an attribute. */
function eventOf(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    specversion: "1.0",
    id: EVENT_1,
    source: "/chance/test",
    type,
    subject: `market/${MARKET_1}`,
    time: "2026-11-01T10:00:00.000Z",
    datacontenttype: "application/json",
    tenantid: TENANT_A,
    correlationid: "corr-1",
    data: { marketId: MARKET_1, tradeSequence: 7 },
    ...overrides,
  };
  for (const [key, value] of Object.entries(event)) if (value === undefined) delete event[key];
  return event;
}

/** A reaction that answers with a fixed outcome or throws a fixed error, and records every notice it got. */
class FakeReaction implements ReactToMarketEventUseCase {
  readonly notices: MarketNotice[] = [];
  constructor(private readonly answer: EventOutcome | Error) {}
  execute(notice: MarketNotice): Promise<EventOutcome> {
    this.notices.push(notice);
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }
}

const OUTCOMES: Array<[string, EventOutcome, "ack" | "nak", string]> = [
  ["quoted", { kind: "quoted", tradeSequence: 7, offers: 6, attempts: 1 }, "ack", "info"],
  ["unchanged", { kind: "unchanged", tradeSequence: 7 }, "ack", "debug"],
  ["stopped", { kind: "stopped", reason: "closed" }, "ack", "info"],
  ["not_ready", { kind: "not_ready", reason: "no_starting_price" }, "nak", "info"],
  ["not_found", { kind: "not_found" }, "ack", "warn"],
  ["disabled", { kind: "disabled" }, "ack", "debug"],
  ["contended", { kind: "contended", attempts: 5 }, "ack", "warn"],
  ["refused", { kind: "refused", status: 409, code: "insufficient_holdings", detail: "the bot holds too little" }, "ack", "error"],
  ["stop_notice", { kind: "stop_notice", event: "market_closed" }, "ack", "info"],
  ["skipped", { kind: "skipped", reason: "before_start" }, "ack", "debug"],
];

describe("handleMarketMessage", () => {
  it.each(OUTCOMES)("%s: %s -> %s, logged at %s", async (_name, outcome, result, level) => {
    const logger = new RecordingLogger();
    const react = new FakeReaction(outcome);

    const handled = await handleMarketMessage(encode(eventOf(TRADE_EXECUTED_TYPE)), react, logger);

    expect(handled.kind).toBe(result);
    if (handled.kind === "nak") expect(handled.reason).toBe(outcome.kind);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level,
      message: "A market event was handled",
      fields: { marketId: MARKET_1, tenantId: TENANT_A, eventId: EVENT_1, eventType: TRADE_EXECUTED_TYPE, correlationId: "corr-1", tradeSequence: 7, outcome: outcome.kind },
    });
  });

  it("acknowledges only the one outcome set that a later delivery cannot change", async () => {
    const naks = [];
    for (const [, outcome] of OUTCOMES) {
      const handled = await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction(outcome), new RecordingLogger());
      if (handled.kind === "nak") naks.push(outcome.kind);
    }
    expect(naks).toEqual(["not_ready"]);
  });

  it("hands the notice to the reaction: all four event types, with the attributes the use case needs", async () => {
    const react = new FakeReaction({ kind: "unchanged", tradeSequence: 0 });

    for (const type of [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE]) {
      await handleMarketMessage(encode(eventOf(type)), react, new RecordingLogger());
    }

    expect(react.notices.map((notice) => notice.kind)).toEqual(["market_opened", "market_closed", "market_resolved", "trade_executed"]);
    expect(react.notices[3]).toMatchObject({ marketId: MARKET_1, tenantId: TENANT_A, eventId: EVENT_1, tradeSequence: 7, correlationId: "corr-1", time: new Date("2026-11-01T10:00:00.000Z") });
  });

  it("an outcome's reason and trading's refusal code reach the log line", async () => {
    const logger = new RecordingLogger();
    await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction({ kind: "stopped", reason: "past_close_time" }), logger);
    await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction({ kind: "refused", status: 400, code: "crossed_offers", detail: "x" }), logger);
    await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction({ kind: "contended", attempts: 5 }), logger);

    expect(logger.lines.map((line) => line.fields)).toEqual([
      expect.objectContaining({ outcome: "stopped", reason: "past_close_time" }),
      expect.objectContaining({ outcome: "refused", status: 400, code: "crossed_offers" }),
      expect.objectContaining({ outcome: "contended", attempts: 5 }),
    ]);
  });

  describe("input that is not an event the bot acts on is acknowledged with a log line, and never reaches the reaction", () => {
    it.each([
      ["a body that is not JSON", "{not json", "warn"],
      ["an empty body", "", "warn"],
      ["JSON that is not an object", "[1, 2]", "warn"],
      ["JSON null", "null", "warn"],
      ["a message that is not a CloudEvent 1.0", encode(eventOf(MARKET_OPENED_TYPE, { specversion: "0.3" })), "warn"],
      ["an event without a tenant", encode(eventOf(MARKET_OPENED_TYPE, { tenantid: undefined })), "warn"],
      ["an event without an id", encode(eventOf(MARKET_OPENED_TYPE, { id: undefined })), "warn"],
      ["a subject that is not a market", encode(eventOf(MARKET_OPENED_TYPE, { subject: "user/abc" })), "warn"],
      ["an event of a type the bot does not consume", encode(eventOf("si.chance.markets.MarketCreated.v1")), "info"],
    ])("%s", async (_name, body, level) => {
      const logger = new RecordingLogger();
      const react = new FakeReaction({ kind: "unchanged", tradeSequence: 0 });

      const handled = await handleMarketMessage(typeof body === "string" ? encode(body) : body, react, logger);

      expect(handled).toEqual({ kind: "ack" });
      expect(react.notices).toEqual([]);
      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]?.level).toBe(level);
    });

    it("a body that is not JSON is logged by its size, never by its content", async () => {
      const logger = new RecordingLogger();

      const body = "secret-looking-text {";

      await handleMarketMessage(encode(body), new FakeReaction({ kind: "disabled" }), logger);

      expect(logger.lines[0]?.fields).toEqual({ bytes: body.length });
      expect(JSON.stringify(logger.lines)).not.toContain("secret-looking-text");
    });
  });

  describe("a failure of the reaction is a nak with the error's code and message", () => {
    it("TradingUnavailable: a warning, the broker delivers the event again", async () => {
      const logger = new RecordingLogger();

      const handled = await handleMarketMessage(encode(eventOf(TRADE_EXECUTED_TYPE)), new FakeReaction(new TradingUnavailable("circuit is open", { scope: "service" })), logger);

      expect(handled).toEqual({ kind: "nak", reason: "trading_unavailable: circuit is open" });
      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]).toMatchObject({ level: "warn", message: "A market event could not be processed; it will be delivered again", fields: { marketId: MARKET_1, eventId: EVENT_1 } });
    });

    it("TradingContractViolation: an error log, the same nak", async () => {
      const logger = new RecordingLogger();

      const handled = await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction(new TradingContractViolation("field tradeSequence is missing")), logger);

      expect(handled).toEqual({ kind: "nak", reason: "trading_contract_violation: field tradeSequence is missing" });
      expect(logger.lines.map((line) => line.level)).toEqual(["error"]);
    });

    it("any other error, and a thrown value that is not an Error, is a nak as well", async () => {
      const fromError = await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), new FakeReaction(new RangeError("out of range")), new RecordingLogger());
      const notAnError: ReactToMarketEventUseCase = {
        execute: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a use case must never do this; the handler still has to cope
          throw "plain text";
        },
      };
      const fromString = await handleMarketMessage(encode(eventOf(MARKET_OPENED_TYPE)), notAnError, new RecordingLogger());

      expect(fromError).toEqual({ kind: "nak", reason: "RangeError: out of range" });
      expect(fromString).toEqual({ kind: "nak", reason: "plain text" });
    });
  });
});

describe("describeError", () => {
  it("uses the code of the error when it has one, else its name", () => {
    expect(describeError(new TradingUnavailable("down"))).toBe("trading_unavailable: down");
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError(Object.assign(new Error("odd"), { code: "" }))).toBe("Error: odd");
  });

  it("describes a value that is not an Error as text", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });

  it("cuts a long message at 500 characters", () => {
    expect(describeError(new Error("x".repeat(2000)))).toHaveLength(500);
    expect(describeError("y".repeat(2000))).toHaveLength(500);
  });
});

/** A JetStream message that records what the settle step did to it. */
class FakeMessage implements SettleableMessage {
  readonly seq = 42;
  readonly subject = "chance.trading.TradeExecuted.tenant-a";
  readonly data = encode("body that must never be logged");
  readonly calls: string[] = [];
  readonly info: { deliveryCount: number };
  constructor(deliveryCount: number) {
    this.info = { deliveryCount };
  }
  ack(): void {
    this.calls.push("ack");
  }
  nak(millis?: number): void {
    this.calls.push(`nak(${String(millis)})`);
  }
}

describe("settleMessage", () => {
  const options = (logger: RecordingLogger) => ({ giveUpAfter: 5, nakDelayMs: 5000, logger, stream: "TRADING" });
  const nak: HandleResult = { kind: "nak", reason: "trading_unavailable: down" };

  it("acknowledges an ack result at any delivery, without a log line", () => {
    const logger = new RecordingLogger();
    for (const deliveries of [1, 5, 9]) {
      const message = new FakeMessage(deliveries);
      expect(settleMessage(message, { kind: "ack" }, options(logger))).toBe("acked");
      expect(message.calls).toEqual(["ack"]);
    }
    expect(logger.lines).toEqual([]);
  });

  it.each([1, 2, 3, 4])("asks for a new delivery after the delay when delivery %i failed", (deliveries) => {
    const logger = new RecordingLogger();
    const message = new FakeMessage(deliveries);

    expect(settleMessage(message, nak, options(logger))).toBe("naked");

    expect(message.calls).toEqual(["nak(5000)"]);
    expect(logger.lines).toEqual([]);
  });

  it.each([5, 6, 40])("gives the event up on delivery %i: an error log with its place in the stream, then an ack", (deliveries) => {
    const logger = new RecordingLogger();
    const message = new FakeMessage(deliveries);

    expect(settleMessage(message, nak, options(logger))).toBe("given_up");

    expect(message.calls).toEqual(["ack"]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: "error",
      fields: { stream: "TRADING", streamSequence: 42, subject: "chance.trading.TradeExecuted.tenant-a", reason: "trading_unavailable: down", deliveries },
    });
    expect(JSON.stringify(logger.lines)).not.toContain("never be logged");
  });

  it("passes the configured give-up number on: with 2 the second failed delivery is the last", () => {
    const logger = new RecordingLogger();

    expect(settleMessage(new FakeMessage(1), nak, { giveUpAfter: 2, nakDelayMs: 10, logger, stream: "MARKETS" })).toBe("naked");
    expect(settleMessage(new FakeMessage(2), nak, { giveUpAfter: 2, nakDelayMs: 10, logger, stream: "MARKETS" })).toBe("given_up");
  });
});
