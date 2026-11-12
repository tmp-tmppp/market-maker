import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { ConsumerMessages, JetStreamManager, JsMsg } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Logger } from "../../usecases/ports.js";
import {
  CONSUMER_ACK_WAIT_MS,
  CONSUMER_DURABLE,
  CONSUMER_MAX_ACK_PENDING,
  CONSUMER_MAX_MESSAGES,
  CONSUMER_NAK_DELAY_MS,
  CONSUMER_WORKING_INTERVAL_MS,
  GIVE_UP_AFTER_DELIVERIES,
} from "../../usecases/support.js";
import { describeError, settleMessage } from "./message-handlers.js";
import type { HandleResult } from "./message-handlers.js";

/** One durable consumer of another service's stream. */
export interface ConsumerSpec {
  /** The stream it reads: MARKETS or TRADING. */
  stream: string;
  /** The durable name: the broker remembers the position of this consumer under it, across restarts. */
  durable: string;
  filterSubjects: string[];
  maxAckPending: number;
}

// The consumers' settings are fixed by the spec: durable pull consumers, deliver policy `new` at creation (the bot starts
// with a check of every open market, so the history of the stream adds nothing), explicit acks, ack wait 30 s kept alive
// with working() while the handler runs, a small max ack pending, max_deliver unlimited (the broker never drops an event;
// GIVE_UP_AFTER_DELIVERIES ends the redelivery of a stuck one).

/** MarketOpened starts the first quote, MarketClosed and MarketResolved only end the logging of a market (EP-1). */
export const MARKETS_CONSUMER: ConsumerSpec = {
  stream: "MARKETS",
  durable: CONSUMER_DURABLE,
  filterSubjects: ["chance.markets.MarketOpened.*", "chance.markets.MarketClosed.*", "chance.markets.MarketResolved.*"],
  maxAckPending: CONSUMER_MAX_ACK_PENDING,
};

/** TradeExecuted: every trade moves the price, so the market is quoted again. */
export const TRADING_CONSUMER: ConsumerSpec = {
  stream: "TRADING",
  durable: CONSUMER_DURABLE,
  filterSubjects: ["chance.trading.TradeExecuted.*"],
  maxAckPending: CONSUMER_MAX_ACK_PENDING,
};

export interface JetStreamConsumerOptions {
  url: string;
  spec: ConsumerSpec;
  /** The rules for one message body (message-handlers.ts); it returns "ack" only after the quote run ended. */
  handle: (data: Uint8Array) => Promise<HandleResult>;
  logger: Logger;
  /** Deliveries after which a failing message is given up and acknowledged. Default GIVE_UP_AFTER_DELIVERIES (5). */
  giveUpAfter?: number;
  /** How long the broker waits for an acknowledgement before it delivers a message again. Default 30 s. */
  ackWaitMs?: number;
  /** Delay of the next delivery after an error. Default 5 s. */
  nakDelayMs?: number;
  /** Wait before the consumer connects again after a failure, or while the stream does not exist yet. Default 5 s. */
  reconnectDelayMs?: number;
  /** While the handler runs, working() goes to the broker this often. Default 10 s; keep it well under the ack wait. */
  workingIntervalMs?: number;
}

const isConsumerMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.ConsumerNotFound;

const isStreamMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

/**
 * A durable pull consumer of a stream of another service (ADR-053; trading's consumer, adapted to a service with no
 * database): the consumer is created, or brought to the spec's configuration, on every connect. The deliver policy can
 * only be chosen when it is created, so an existing durable keeps its position and resumes at its ack floor after an
 * outage; what it replays is acknowledged without a call when it predates the process start (ReactToMarketEvent).
 *
 * The service starts and serves without it: a missing stream (the publisher may start later), a refused connection, a
 * lost connection or a consume loop that ended is logged at warn and tried again after `reconnectDelayMs`; the health
 * route only reports `isConnected()`. Messages are pulled and handled one at a time: only the message in hand is kept
 * alive with working(), so a second one waiting in the client would pass the ack wait behind a long quote run and come
 * back as a duplicate. A message is acknowledged after the handler returned "ack"; "nak" asks for a new delivery after
 * `nakDelayMs`; the delivery number `giveUpAfter` gives the message up (settleMessage). stop() finishes the message in hand.
 */
export class JetStreamConsumer {
  private nc: NatsConnection | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private active: ConsumerMessages | null = null;
  private wake: (() => void) | null = null;
  /** True between a "disconnect" and the next "reconnect" status of the connection (the client reconnects by itself). */
  private linkDown = false;
  private readonly giveUpAfter: number;
  private readonly ackWaitMs: number;
  private readonly nakDelayMs: number;
  private readonly reconnectDelayMs: number;
  private readonly workingIntervalMs: number;

  constructor(private readonly options: JetStreamConsumerOptions) {
    this.giveUpAfter = options.giveUpAfter ?? GIVE_UP_AFTER_DELIVERIES;
    this.ackWaitMs = options.ackWaitMs ?? CONSUMER_ACK_WAIT_MS;
    this.nakDelayMs = options.nakDelayMs ?? CONSUMER_NAK_DELAY_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
    this.workingIntervalMs = options.workingIntervalMs ?? CONSUMER_WORKING_INTERVAL_MS;
  }

  /** Starts the loop; returns at once and never throws. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Stops the loop, waits for the message in progress and closes the connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    this.active?.stop();
    await this.loop;
    this.loop = null;
    const nc = this.nc;
    this.nc = null;
    if (nc && !nc.isClosed()) await nc.drain().catch(() => undefined);
  }

  /** True while the broker is reachable and the consume loop runs: what `/health/ready` reports as `broker`. */
  isConnected(): boolean {
    return this.nc !== null && !this.nc.isClosed() && !this.linkDown && this.active !== null;
  }

  private async ensureConsumer(manager: JetStreamManager): Promise<void> {
    const { stream, durable, filterSubjects, maxAckPending } = this.options.spec;
    // One filter goes in "filter_subject", several in "filter_subjects": the broker refuses both at once, and an update
    // merges into the stored configuration, so the key that is not used is set to undefined explicitly.
    const [onlyFilter] = filterSubjects;
    const filters =
      filterSubjects.length === 1 && onlyFilter !== undefined
        ? { filter_subject: onlyFilter, filter_subjects: undefined }
        : { filter_subject: undefined, filter_subjects: filterSubjects };
    const settings = { ack_wait: nanos(this.ackWaitMs), max_ack_pending: maxAckPending, max_deliver: -1, ...filters };
    try {
      await manager.consumers.info(stream, durable);
    } catch (error) {
      // A missing stream also throws here and is left to the loop, which logs it and tries again.
      if (!isConsumerMissing(error)) throw error;
      // `new`: only events published from now on; a deleted and re-created consumer therefore misses what arrived in
      // between, which the periodic check covers.
      await manager.consumers.add(stream, { durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.New, ...settings });
      return;
    }
    await manager.consumers.update(stream, durable, settings);
  }

  /** Reuses an open connection; otherwise connects, and watches its status for the log and for `isConnected()`. */
  private async connection(): Promise<NatsConnection> {
    if (this.nc && !this.nc.isClosed()) return this.nc;
    const { url, spec } = this.options;
    const nc = await connect({ servers: url, name: `market-maker-consumer-${spec.stream.toLowerCase()}`, maxReconnectAttempts: -1 });
    this.nc = nc;
    this.linkDown = false;
    void this.watchStatus(nc);
    return nc;
  }

  private async watchStatus(nc: NatsConnection): Promise<void> {
    const { spec, logger } = this.options;
    const fields = { stream: spec.stream, durable: spec.durable };
    try {
      for await (const status of nc.status()) {
        if (nc !== this.nc) return;
        if (status.type === "disconnect") {
          this.linkDown = true;
          logger.warn(fields, "The connection to NATS was lost; the client reconnects by itself");
        } else if (status.type === "reconnect") {
          this.linkDown = false;
          logger.info(fields, "Reconnected to NATS");
        }
      }
    } catch (error) {
      logger.warn({ ...fields, err: error }, "The status of the NATS connection can no longer be followed");
    }
  }

  /** Runs the handler for one message and keeps the broker's ack wait from running out while it works. */
  private async handleMessage(message: JsMsg): Promise<HandleResult> {
    const { handle, logger, spec } = this.options;
    const timer = setInterval(() => {
      try {
        message.working();
      } catch (error) {
        logger.warn({ stream: spec.stream, streamSequence: message.seq, err: error }, "The broker could not be told that a message is still in progress");
      }
    }, this.workingIntervalMs);
    try {
      return await handle(message.data);
    } catch (error) {
      // The handler answers with a result for every failure it knows; this is a defect, and the message must not be lost.
      logger.error({ stream: spec.stream, streamSequence: message.seq, err: error }, "The handler of a message threw; it will be delivered again");
      return { kind: "nak", reason: describeError(error) };
    } finally {
      clearInterval(timer);
    }
  }

  private async run(): Promise<void> {
    const { spec, logger } = this.options;
    const { stream, durable, filterSubjects } = spec;
    let failures = 0;
    while (!this.stopping) {
      try {
        const nc = await this.connection();
        await this.ensureConsumer(await jetstreamManager(nc));
        const consumer = await jetstream(nc).consumers.get(stream, durable);
        // One message per pull (CONSUMER_MAX_MESSAGES): the next pull is sent only after the loop below took the message in
        // hand and finished it. By default consume() waits silently for a deleted consumer or stream to come back, and
        // nothing here would bring it back: with the abort option the loop ends, logs, and ensureConsumer() creates the
        // consumer again.
        const messages = await consumer.consume({ max_messages: CONSUMER_MAX_MESSAGES, abort_on_missing_resource: true });
        this.active = messages;
        // stop() may have been called while the consumer was being set up: it saw no active messages then.
        if (this.stopping) messages.stop();
        failures = 0;
        logger.info({ stream, durable, filters: filterSubjects }, "Consuming events");
        try {
          for await (const message of messages) {
            const result = await this.handleMessage(message);
            settleMessage(message, result, { giveUpAfter: this.giveUpAfter, nakDelayMs: this.nakDelayMs, logger, stream });
          }
        } finally {
          this.active = null;
        }
        if (!this.stopping) logger.warn({ stream, durable }, `The ${stream} consume loop ended; trying again`);
      } catch (error) {
        failures += 1;
        const text = isStreamMissing(error) ? `The ${stream} stream does not exist yet; trying again` : `The ${stream} consumer failed; trying again`;
        logger.warn({ stream, durable, attempt: failures, err: error }, text);
      }
      if (!this.stopping) await this.sleep(this.reconnectDelayMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
