import { createConnection, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JetStreamConsumer, MARKETS_CONSUMER, TRADING_CONSUMER } from "../../src/adapters/nats/jetstream-consumer.js";
import type { ConsumerSpec } from "../../src/adapters/nats/jetstream-consumer.js";
import { handleMarketMessage } from "../../src/adapters/nats/message-handlers.js";
import type { HandleResult } from "../../src/adapters/nats/message-handlers.js";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE } from "../../src/domain/consumed.js";
import type { MarketNotice } from "../../src/domain/consumed.js";
import { CONSUMER_ACK_WAIT_MS, CONSUMER_DURABLE, CONSUMER_MAX_ACK_PENDING, CONSUMER_MAX_MESSAGES, GIVE_UP_AFTER_DELIVERIES } from "../../src/usecases/support.js";
import type { EventOutcome, ReactToMarketEventUseCase } from "../../src/usecases/use-cases.js";
import { MARKET_1, RecordingLogger, TENANT_A } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They run against a real NATS server with
// JetStream, because the stream and consumer calls of the broker are what src/adapters/nats consists of. The streams
// belong to the publishers (markets, trading), so each test creates them as the publishers do.

let container: StartedTestContainer;
let url: string;
let host: string;
let port: number;
let nc: NatsConnection;
let jsm: JetStreamManager;
let js: JetStreamClient;

beforeAll(async () => {
  container = await new GenericContainer("nats:2.15.2-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  host = container.getHost();
  port = container.getMappedPort(4222);
  url = `nats://${host}:${String(port)}`;
  nc = await connect({ servers: url });
  jsm = await jetstreamManager(nc);
  js = jetstream(nc);
}, 180_000);

afterAll(async () => {
  await nc?.drain().catch(() => undefined);
  await container?.stop();
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
}

const isStreamMissing = (error: unknown): boolean => error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

async function deleteStream(name: string): Promise<void> {
  try {
    await jsm.streams.delete(name);
  } catch (error) {
    if (!isStreamMissing(error)) throw error;
  }
}

const publish = (subject: string, body: unknown): Promise<unknown> => js.publish(subject, new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));

const marketsSubject = (type: string): string => `chance.markets.${type}.${TENANT_A}`;
const eventId = (n: number): string => `018f3c1e-7a00-7000-8000-${String(n).padStart(12, "0")}`;
const GAVE_UP = "An event failed too many deliveries; it was given up and acknowledged (the periodic check quotes its market)";

/** A TCP relay to the broker that the test can cut: the client sees a lost connection, then a reachable server again. */
class CuttableRelay {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  accepting = true;

  constructor(private readonly target: { host: string; port: number }) {
    this.server = createServer((client) => {
      if (!this.accepting) {
        client.destroy();
        return;
      }
      const upstream = createConnection(this.target);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
        socket.on("close", () => {
          client.destroy();
          upstream.destroy();
          this.sockets.delete(socket);
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  close(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/** What the consumer hands to its handler; a body can be held back, or fail a number of times, like a quote run that cannot finish. */
class RecordingHandler {
  readonly bodies: string[] = [];
  /** Failures left to answer with a nak, for bodies that start with `failPrefix`. */
  failures = 0;
  failPrefix = "";
  /** Bodies that wait for their gate before the handler answers. */
  readonly gates = new Map<string, Deferred>();
  /** Bodies that throw instead of answering (a defect in the handler), once each. */
  readonly throwOnce = new Set<string>();

  readonly handle = async (data: Uint8Array): Promise<HandleResult> => {
    const body = new TextDecoder().decode(data);
    this.bodies.push(body);
    await this.gates.get(body)?.promise;
    if (this.throwOnce.delete(body)) throw new Error("a defect in the handler");
    if (this.failures > 0 && body.startsWith(this.failPrefix)) {
      this.failures -= 1;
      return { kind: "nak", reason: "database is down" };
    }
    return { kind: "ack" };
  };
}

describe("the consumer specs", () => {
  it("use the names of the convention: durable market-maker on the streams MARKETS and TRADING, the filters of the spec", () => {
    expect([MARKETS_CONSUMER, TRADING_CONSUMER].map((spec) => [spec.stream, spec.durable, spec.maxAckPending])).toEqual([
      ["MARKETS", "market-maker", 10],
      ["TRADING", "market-maker", 10],
    ]);
    expect(MARKETS_CONSUMER.filterSubjects).toEqual(["chance.markets.MarketOpened.*", "chance.markets.MarketClosed.*", "chance.markets.MarketResolved.*"]);
    expect(TRADING_CONSUMER.filterSubjects).toEqual(["chance.trading.TradeExecuted.*"]);
    expect(CONSUMER_DURABLE).toBe("market-maker");
    expect(CONSUMER_MAX_MESSAGES).toBe(1);
    expect(GIVE_UP_AFTER_DELIVERIES).toBe(5);
  });
});

describe("JetStreamConsumer", () => {
  let handler: RecordingHandler;
  let logger: RecordingLogger;
  let consumers: JetStreamConsumer[];
  let relays: CuttableRelay[];

  const startConsumer = (spec: ConsumerSpec, options: Partial<ConstructorParameters<typeof JetStreamConsumer>[0]> = {}): JetStreamConsumer => {
    const consumer = new JetStreamConsumer({ url, spec, handle: handler.handle, logger, nakDelayMs: 50, reconnectDelayMs: 50, ...options });
    consumers.push(consumer);
    consumer.start();
    return consumer;
  };
  const createStream = (spec: ConsumerSpec, subjects: string[]) => jsm.streams.add({ name: spec.stream, subjects });
  const info = (spec: ConsumerSpec) => jsm.consumers.info(spec.stream, spec.durable);
  /** True once every delivered message was acknowledged and nothing is left for the consumer. */
  const settled = (spec: ConsumerSpec) => async (): Promise<boolean> => {
    const current = await info(spec);
    return current.num_ack_pending === 0 && current.num_pending === 0;
  };
  /** The consumer has been created and is consuming: only events published after that reach a `new` consumer. */
  const consuming = (count = 1) => (): boolean => logger.messages("info").filter((message) => message === "Consuming events").length >= count;

  beforeEach(async () => {
    for (const spec of [MARKETS_CONSUMER, TRADING_CONSUMER]) await deleteStream(spec.stream);
    handler = new RecordingHandler();
    logger = new RecordingLogger();
    consumers = [];
    relays = [];
  });
  afterEach(async () => {
    // A test that failed while a handler waited for its gate must not leave stop() waiting for that handler.
    for (const gate of handler.gates.values()) gate.resolve();
    await Promise.all(consumers.map((consumer) => consumer.stop()));
    await Promise.all(relays.map((relay) => relay.close()));
  });

  describe("the consumer on the broker", () => {
    it.each([
      [MARKETS_CONSUMER, "chance.markets.>"],
      [TRADING_CONSUMER, "chance.trading.>"],
    ])("is created on %#: durable market-maker, explicit acks, deliver policy new, ack wait 30 s, max ack pending 10, unlimited deliveries, the filters", async (spec, subjects) => {
      await createStream(spec, [subjects]);

      startConsumer(spec);
      await waitFor(consuming());

      const { config } = await info(spec);
      expect(config).toMatchObject({
        durable_name: CONSUMER_DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        ack_wait: nanos(CONSUMER_ACK_WAIT_MS),
        max_ack_pending: CONSUMER_MAX_ACK_PENDING,
        max_deliver: -1,
      });
      expect([...(config.filter_subjects ?? [config.filter_subject])].sort()).toEqual([...spec.filterSubjects].sort());
    });

    it("is brought to the spec when it exists with another configuration, but keeps its deliver policy and its position", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      await jsm.consumers.add(MARKETS_CONSUMER.stream, {
        durable_name: CONSUMER_DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subject: "chance.markets.MarketOpened.*",
        ack_wait: nanos(5000),
        max_ack_pending: 100,
      });

      startConsumer(MARKETS_CONSUMER, { ackWaitMs: 20_000 });
      await waitFor(consuming());

      const { config } = await info(MARKETS_CONSUMER);
      expect(config).toMatchObject({ ack_wait: nanos(20_000), max_ack_pending: 10, max_deliver: -1, deliver_policy: DeliverPolicy.All });
      expect([...(config.filter_subjects ?? [])].sort()).toEqual([...MARKETS_CONSUMER.filterSubjects].sort());
      expect(config.filter_subject).toBeUndefined();
    });

    it("starts from new events: what was published before the consumer existed is not delivered, and other subjects are filtered out", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      await publish(marketsSubject("MarketOpened"), "before the consumer");

      startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());
      await publish(`chance.markets.MarketCreated.${TENANT_A}`, "not ours");
      await publish(marketsSubject("MarketOpened"), "after the consumer");
      await waitFor(() => handler.bodies.length === 1);
      await waitFor(settled(MARKETS_CONSUMER));
      await sleep(300);

      expect(handler.bodies).toEqual(["after the consumer"]);
    });
  });

  describe("handling a message", () => {
    it("acknowledges only after the handler returned", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const release = new Deferred();
      handler.gates.set("event", release);
      startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());

      await publish(marketsSubject("MarketClosed"), "event");
      await waitFor(() => handler.bodies.length === 1);
      const during = await info(MARKETS_CONSUMER);

      expect(during.num_ack_pending).toBe(1);
      expect(during.ack_floor.stream_seq).toBe(0);

      release.resolve();
      await waitFor(settled(MARKETS_CONSUMER));

      expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(1);
    });

    it("pulls one message at a time: a handler that outlasts the ack wait gets no duplicate of itself and none of the messages behind it", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const release = new Deferred();
      handler.gates.set("one", release);
      startConsumer(MARKETS_CONSUMER, { ackWaitMs: 1500, workingIntervalMs: 300 });
      await waitFor(consuming());

      await publish(marketsSubject("MarketOpened"), "one");
      await publish(marketsSubject("MarketOpened"), "two");
      await publish(marketsSubject("MarketOpened"), "three");
      await waitFor(() => handler.bodies.length === 1);
      // Well past the ack wait: the first message is kept alive by working(), the others have not left the broker.
      await sleep(2800);
      const during = await info(MARKETS_CONSUMER);

      expect(handler.bodies).toEqual(["one"]);
      expect(during.num_ack_pending).toBe(1);
      expect(during.num_pending).toBe(2);
      expect(during.delivered.consumer_seq).toBe(1);

      release.resolve();
      await waitFor(() => handler.bodies.length === 3);
      await waitFor(settled(MARKETS_CONSUMER));
      const after = await info(MARKETS_CONSUMER);

      expect(handler.bodies).toEqual(["one", "two", "three"]);
      expect(after.delivered.consumer_seq).toBe(3);
      expect(after.ack_floor.stream_seq).toBe(3);
    }, 30_000);

    it("keeps a message alive while the handler runs: past the ack wait the broker does not offer it to another pull", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const release = new Deferred();
      handler.gates.set("long", release);
      startConsumer(MARKETS_CONSUMER, { ackWaitMs: 1500, workingIntervalMs: 300 });
      await waitFor(consuming());
      await publish(marketsSubject("MarketOpened"), "long");
      await waitFor(() => handler.bodies.length === 1);
      await sleep(2300);

      // A second client pulling from the same durable would be handed the message if its ack wait had run out.
      const other = await js.consumers.get(MARKETS_CONSUMER.stream, MARKETS_CONSUMER.durable);
      const offered = await other.next({ expires: 1000 });

      expect(offered).toBeNull();
      release.resolve();
      await waitFor(settled(MARKETS_CONSUMER));
      expect(handler.bodies).toEqual(["long"]);
      expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(1);
    }, 30_000);

    it("asks the broker to deliver again after a nak, and gives the event up on the fifth failed delivery without holding back the next one", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      handler.failures = 100;
      handler.failPrefix = "poison";
      startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());

      await publish(marketsSubject("MarketOpened"), "poison");
      await publish(marketsSubject("MarketClosed"), "next");
      await waitFor(() => logger.messages("error").includes(GAVE_UP));
      await waitFor(() => handler.bodies.includes("next"));
      await waitFor(settled(MARKETS_CONSUMER));

      expect(handler.bodies.filter((body) => body === "poison")).toHaveLength(5);
      expect(logger.lines.filter((line) => line.message === GAVE_UP)).toHaveLength(1);
      expect(logger.lines.find((line) => line.message === GAVE_UP)?.fields).toEqual({
        stream: "MARKETS",
        streamSequence: 1,
        subject: marketsSubject("MarketOpened"),
        reason: "database is down",
        deliveries: 5,
      });
      // The next message was handled while the poisoned one waited for its redelivery.
      expect(handler.bodies.indexOf("next")).toBeLessThan(handler.bodies.lastIndexOf("poison"));
      expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(2);
    });

    it("does not give up before the fifth delivery: four failures and then a success acknowledge the event once", async () => {
      await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
      handler.failures = 4;
      startConsumer(TRADING_CONSUMER);
      await waitFor(consuming());

      await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "flaky");
      await waitFor(() => handler.bodies.length === 5);
      await waitFor(settled(TRADING_CONSUMER));

      expect(logger.messages("error")).toEqual([]);
      expect((await info(TRADING_CONSUMER)).ack_floor.stream_seq).toBe(1);
    });

    it("treats a handler that throws as a nak: the message comes back and is handled", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      handler.throwOnce.add("defect");
      startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());

      await publish(marketsSubject("MarketOpened"), "defect");
      await waitFor(() => handler.bodies.length === 2);
      await waitFor(settled(MARKETS_CONSUMER));

      expect(logger.messages("error")).toEqual(["The handler of a message threw; it will be delivered again"]);
      expect(handler.bodies).toEqual(["defect", "defect"]);
    });

    it("stop() finishes the message in hand, acknowledges it, and closes the connection", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const release = new Deferred();
      handler.gates.set("slow", release);
      const consumer = startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());
      await publish(marketsSubject("MarketOpened"), "slow");
      await waitFor(() => handler.bodies.length === 1);

      let stopped = false;
      const stopping = consumer.stop().then(() => {
        stopped = true;
      });
      await sleep(300);
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;

      expect(consumer.isConnected()).toBe(false);
      expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(1);
    });

    it("lets the real handler decide per stream: MarketOpened, MarketClosed and MarketResolved on MARKETS and TradeExecuted on TRADING reach the reaction, other types do not", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
      const notices: MarketNotice[] = [];
      const react: ReactToMarketEventUseCase = {
        execute: (notice): Promise<EventOutcome> => {
          notices.push(notice);
          return Promise.resolve({ kind: "unchanged", tradeSequence: 0 });
        },
      };
      const handle = (data: Uint8Array): Promise<HandleResult> => handleMarketMessage(data, react, logger);
      startConsumer(MARKETS_CONSUMER, { handle });
      startConsumer(TRADING_CONSUMER, { handle });
      await waitFor(consuming(2));
      const envelope = (type: string, n: number): Record<string, unknown> => ({
        specversion: "1.0",
        id: eventId(n),
        source: "/chance/test",
        type,
        subject: `market/${MARKET_1}`,
        time: "2026-11-01T10:00:00.000Z",
        datacontenttype: "application/json",
        tenantid: TENANT_A,
        correlationid: `corr-${String(n)}`,
        data: { marketId: MARKET_1, tradeSequence: 3 },
      });

      await publish(marketsSubject("MarketOpened"), envelope(MARKET_OPENED_TYPE, 1));
      await publish(`chance.markets.MarketCreated.${TENANT_A}`, envelope("si.chance.markets.MarketCreated.v1", 2));
      await publish(marketsSubject("MarketClosed"), envelope(MARKET_CLOSED_TYPE, 3));
      await publish(marketsSubject("MarketResolved"), envelope(MARKET_RESOLVED_TYPE, 4));
      await publish(`chance.trading.TradeExecuted.${TENANT_A}`, envelope(TRADE_EXECUTED_TYPE, 5));
      await waitFor(() => notices.length === 4);
      await waitFor(settled(MARKETS_CONSUMER));
      await waitFor(settled(TRADING_CONSUMER));

      expect(notices.map((notice) => notice.kind).sort()).toEqual(["market_closed", "market_opened", "market_resolved", "trade_executed"]);
      expect(notices.find((notice) => notice.kind === "trade_executed")).toMatchObject({ eventId: eventId(5), tenantId: TENANT_A, marketId: MARKET_1, tradeSequence: 3, correlationId: "corr-5" });
      expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(4);
      expect((await info(TRADING_CONSUMER)).ack_floor.stream_seq).toBe(1);
    });
  });

  describe("the connection and the stream", () => {
    it("is not connected before start, and is while consuming and no longer after stop", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const consumer = new JetStreamConsumer({ url, spec: MARKETS_CONSUMER, handle: handler.handle, logger, reconnectDelayMs: 50 });
      consumers.push(consumer);
      expect(consumer.isConnected()).toBe(false);

      consumer.start();
      await waitFor(() => consumer.isConnected());
      await consumer.stop();

      expect(consumer.isConnected()).toBe(false);
    });

    it("starts without the stream, says so, reports not connected, and consumes when the stream appears", async () => {
      const consumer = startConsumer(MARKETS_CONSUMER);
      await waitFor(() => logger.messages("warn").includes("The MARKETS stream does not exist yet; trying again"));
      expect(consumer.isConnected()).toBe(false);
      expect(handler.bodies).toEqual([]);

      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      await waitFor(consuming());
      await publish(marketsSubject("MarketOpened"), "late");
      await waitFor(() => handler.bodies.length === 1);

      expect(consumer.isConnected()).toBe(true);
      expect(handler.bodies).toEqual(["late"]);
    });

    it("creates the consumer again when it is deleted while consuming, and goes on consuming", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const consumer = startConsumer(MARKETS_CONSUMER);
      await waitFor(consuming());
      await publish(marketsSubject("MarketOpened"), "before");
      await waitFor(() => handler.bodies.length === 1);
      await waitFor(settled(MARKETS_CONSUMER));

      await jsm.consumers.delete(MARKETS_CONSUMER.stream, MARKETS_CONSUMER.durable);
      await waitFor(consuming(2), 30_000);
      await publish(marketsSubject("MarketOpened"), "after");
      await waitFor(() => handler.bodies.length === 2);

      expect(logger.messages("warn").some((message) => message.startsWith("The MARKETS"))).toBe(true);
      expect(consumer.isConnected()).toBe(true);
      expect(handler.bodies).toEqual(["before", "after"]);
      expect((await info(MARKETS_CONSUMER)).config.deliver_policy).toBe(DeliverPolicy.New);
    }, 45_000);

    it("reports a lost connection, logs it, and consumes again once the client reconnected by itself", async () => {
      await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
      const relay = new CuttableRelay({ host, port });
      relays.push(relay);
      const relayPort = await relay.listen();
      const consumer = startConsumer(MARKETS_CONSUMER, { url: `nats://127.0.0.1:${String(relayPort)}` });
      await waitFor(consuming());
      await waitFor(() => consumer.isConnected());

      relay.accepting = false;
      relay.dropConnections();
      await waitFor(() => !consumer.isConnected());
      expect(logger.messages("warn")).toContain("The connection to NATS was lost; the client reconnects by itself");

      relay.accepting = true;
      await waitFor(() => consumer.isConnected(), 30_000);
      expect(logger.messages("info")).toContain("Reconnected to NATS");
      await publish(marketsSubject("MarketOpened"), "after the outage");
      await waitFor(() => handler.bodies.length === 1, 30_000);

      expect(handler.bodies).toEqual(["after the outage"]);
    }, 60_000);
  });
});
