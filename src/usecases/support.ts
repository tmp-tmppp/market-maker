import type { Random } from "./ports.js";
import type { EventOutcome } from "./use-cases.js";

// Shared constants and helpers of the use cases and the consumers. Fixed values, not configuration: changing one is a
// code change with its tests.

/** Quote attempts per run when trading answers 409 stale_sequence (a trade happened between the read and the PUT). */
export const STALE_RETRY_ATTEMPTS = 5;
/** The base of the wait between two attempts: base x attempt x (0.5 .. 1.5), so concurrent bots drift apart. */
export const STALE_RETRY_BASE_DELAY_MS = 100;
/** Markets per page of the periodic check (trading's default; its maximum is 500). */
export const LIST_PAGE_SIZE = 100;

/** The durable name of both consumers (MARKETS and TRADING streams): the broker keeps their positions under it. */
export const CONSUMER_DURABLE = "market-maker";
/** Unacknowledged messages per consumer at most (as trading's consumers). */
export const CONSUMER_MAX_ACK_PENDING = 10;
/**
 * Messages one pull fetches. The handler takes one message at a time and only the message in hand is kept alive with
 * working(), so a larger batch would leave buffered messages to pass the ack wait behind a long run and come back as
 * duplicates with a higher delivery count.
 */
export const CONSUMER_MAX_MESSAGES = 1;
/** How long the broker waits for an acknowledgement before it delivers again; a running handler extends it. */
export const CONSUMER_ACK_WAIT_MS = 30_000;
/** While a handler runs, the consumer tells the broker every this often that it is still working on the message. */
export const CONSUMER_WORKING_INTERVAL_MS = 10_000;
/** The wait before a nak'd message is delivered again. */
export const CONSUMER_NAK_DELAY_MS = 5000;
/**
 * Deliveries after which a failing event is given up: logged as an error and acknowledged. The bot keeps no state, so
 * nothing is lost: the periodic check quotes the market again within RECHECK_INTERVAL_MS (trading's consumers park
 * instead, because they would lose a change).
 */
export const GIVE_UP_AFTER_DELIVERIES = 5;
/**
 * An event whose CloudEvent `time` is older than the process start by more than this is acknowledged without a call:
 * the start-up check (and every later one) reads every open book after it, so the backlog a durable consumer replays
 * after an outage would only cost one GET each and delay fresh events. The margin absorbs clock skew between the
 * publishers and the bot.
 */
export const EVENT_BEFORE_START_MARGIN_MS = 60_000;

/** True when an event published at `time` predates `startedAt` by more than the margin (null `time`: never). */
export function predatesStart(time: Date | null, startedAt: Date): boolean {
  return time !== null && time.getTime() < startedAt.getTime() - EVENT_BEFORE_START_MARGIN_MS;
}

/** The wait before stale_sequence attempt `attempt + 1` (attempt counts from 1). */
export function staleRetryDelayMs(attempt: number, random: Random): number {
  return Math.floor(STALE_RETRY_BASE_DELAY_MS * attempt * (0.5 + random.next()));
}

/**
 * True for the outcomes a later delivery of the event may change: the consumer naks them; every other one is acked.
 * Only "not_ready" (trading has not processed MarketOpened yet). "contended" is acked: every trade that caused the
 * stale answers publishes its own TradeExecuted, whose run reads the newer book, and the periodic check covers the rest;
 * a nak would only hold one of the consumer's ack-pending places.
 */
export function wantsRedelivery(outcome: EventOutcome): boolean {
  return outcome.kind === "not_ready";
}

/**
 * Serializes asynchronous work per key inside one process: the quote runs of one market never overlap (two runs would
 * read the same book and the second PUT would only meet 409 stale_sequence). At most one run per key is in progress and
 * at most one waits behind it; a caller that arrives while one waits shares that waiting run and its result (the work
 * of the first waiting caller runs). The waiting run starts after the one in progress, so it reads a book at least as
 * new as any event that arrived meanwhile. This only works inside one process, so the bot runs as one replica with the
 * Recreate strategy: a PUT does not change the trade sequence, so two writers on the same sequence would both be
 * accepted, the last one winning, and two pods with different settings or code would swap the book on every trigger.
 */
export class KeyedSerializer<T> {
  private readonly running = new Map<string, Promise<T>>();
  private readonly waiting = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const queued = this.waiting.get(key);
    if (queued) return queued;
    const current = this.running.get(key);
    if (!current) return this.start(key, work);
    const next = current.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      this.waiting.delete(key);
      return this.start(key, work);
    });
    this.waiting.set(key, next);
    return next;
  }

  /** Keys with a run in progress. */
  get activeKeys(): number {
    return this.running.size;
  }

  private start(key: string, work: () => Promise<T>): Promise<T> {
    const tracked: Promise<T> = Promise.resolve()
      .then(work)
      .finally(() => {
        if (this.running.get(key) === tracked) this.running.delete(key);
      });
    this.running.set(key, tracked);
    return tracked;
  }
}
