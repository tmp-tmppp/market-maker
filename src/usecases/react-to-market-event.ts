import type { MarketNotice } from "../domain/consumed.js";
import type { Logger } from "./ports.js";
import { predatesStart } from "./support.js";
import type { EventOutcome, QuoteMarketUseCase, ReactToMarketEventUseCase } from "./use-cases.js";

export interface ReactToMarketEventOptions {
  /** The process start, taken once by the composition root before the consumers and the scheduler start. */
  startedAt: Date;
}

/**
 * The reaction to one consumed event (EP-1, ADR-041). The event is only a notification: MarketOpened and TradeExecuted
 * start a quote run of the market, which reads the book from trading again, so nothing in the event decides what the
 * bot offers and a duplicate, late or reordered event costs one read. MarketClosed and MarketResolved need no call:
 * trading cancels the offers itself, and the next periodic check no longer lists the market.
 *
 * An opening or trade event published before the process started (by more than the margin of support.ts) is skipped
 * without a call: a durable consumer that was offline replays its backlog, and the start-up check, which runs after the
 * consumers start, reads every open book anyway.
 */
export class ReactToMarketEvent implements ReactToMarketEventUseCase {
  constructor(
    private readonly quote: QuoteMarketUseCase,
    private readonly logger: Logger,
    private readonly options: ReactToMarketEventOptions,
  ) {}

  async execute(notice: MarketNotice): Promise<EventOutcome> {
    const kind = notice.kind;
    const fields = { marketId: notice.marketId, tenantId: notice.tenantId, eventId: notice.eventId, eventType: notice.eventType, correlationId: notice.correlationId ?? notice.eventId };
    switch (kind) {
      case "market_closed":
      case "market_resolved":
        this.logger.info(fields, "Market ended, nothing to quote");
        return { kind: "stop_notice", event: kind };
      case "market_opened":
      case "trade_executed":
        if (predatesStart(notice.time, this.options.startedAt)) {
          this.logger.debug({ ...fields, time: notice.time }, "Event predates the process start, the start-up check covers it");
          return { kind: "skipped", reason: "before_start" };
        }
        return this.quote.execute({ marketId: notice.marketId, trigger: kind, tenantId: notice.tenantId, knownSequence: notice.tradeSequence, correlationId: fields.correlationId });
    }
  }
}
