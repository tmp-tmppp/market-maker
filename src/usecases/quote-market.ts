import { quotingStateOf } from "../domain/book.js";
import { DomainError } from "../domain/errors.js";
import { offerViolations, sameOffers } from "../domain/offers.js";
import type { Offer } from "../domain/offers.js";
import { computeOffers, referencePriceOf } from "../domain/pricing.js";
import type { PricingInput } from "../domain/pricing.js";
import type { QuoteDeps, ReplaceOffersRequest } from "./ports.js";
import { KeyedSerializer, STALE_RETRY_ATTEMPTS, staleRetryDelayMs } from "./support.js";
import type { QuoteMarketInput, QuoteMarketUseCase, QuoteOutcome } from "./use-cases.js";

/**
 * One quote run of one market (EP-1, FL-A steps 3-7, ADR-041): read the bot's book from trading, compute the offers from
 * it (pricing.ts, Proposed ADR-057), and replace the resting offers in one PUT priced on the book's trade sequence. The
 * bot keeps no copy of the book, so the run is idempotent: it always starts from a fresh read and an equal list is not
 * even sent, which makes a duplicate, late or reordered notification cost one read.
 *
 * Runs of one market never overlap inside the process (KeyedSerializer): two runs would read the same book and the
 * second PUT would only meet 409 stale_sequence. The whole run, all its attempts included, is one serialized unit, so a
 * notification that arrives while a run waits shares that waiting run, which starts after the one in progress and so
 * reads a book at least as new as the notification.
 *
 * A trade between the read and the PUT is answered 409 stale_sequence (a trade raises the sequence, a replacement does
 * not); the run waits a jittered, growing time and reads again, at most STALE_RETRY_ATTEMPTS times, and then ends as
 * "contended": the trades that caused the stale answers each publish their own TradeExecuted, and the periodic check
 * covers the rest.
 */
export class QuoteMarket implements QuoteMarketUseCase {
  constructor(
    private readonly deps: QuoteDeps,
    private readonly serializer: KeyedSerializer<QuoteOutcome> = new KeyedSerializer(),
  ) {}

  execute(input: QuoteMarketInput): Promise<QuoteOutcome> {
    return this.serializer.run(input.marketId, () => this.observed(input));
  }

  /** One serialized run, reported to the observer once, however many callers share it. */
  private async observed(input: QuoteMarketInput): Promise<QuoteOutcome> {
    let outcome: QuoteOutcome;
    try {
      outcome = await this.run(input);
    } catch (error) {
      this.report({ kind: "error" });
      throw error;
    }
    this.report(outcome);
    return outcome;
  }

  private report(result: QuoteOutcome | { kind: "error" }): void {
    try {
      this.deps.observer?.runEnded(result);
    } catch (error) {
      this.deps.logger.warn({ err: error }, "The quote observer failed; the run is not affected");
    }
  }

  private async run(input: QuoteMarketInput): Promise<QuoteOutcome> {
    const { trading, settings: source, clock, delay, random, logger } = this.deps;
    // Read once per run, so one run prices every attempt with the same settings (the kill switch and the ladder).
    const settings = source.current();
    const base = { marketId: input.marketId, tenantId: input.tenantId, trigger: input.trigger, correlationId: input.correlationId };
    if (!settings.enabled) {
      logger.debug(base, "Quoting is disabled");
      return { kind: "disabled" };
    }

    const context = { correlationId: input.correlationId };
    let tenantMismatchLogged = false;
    for (let attempt = 1; attempt <= STALE_RETRY_ATTEMPTS; attempt += 1) {
      const book = await trading.getBotBook(input.marketId, context);
      if (book === null) {
        logger.warn(base, "Market not found");
        return { kind: "not_found" };
      }
      const fields = { ...base, tenantId: book.market.tenantId, tradeSequence: book.tradeSequence };
      // trading takes the tenant from the market, never from the event: a difference is worth a line, not a stop.
      if (!tenantMismatchLogged && input.tenantId !== null && book.market.tenantId !== input.tenantId) {
        tenantMismatchLogged = true;
        logger.warn({ ...fields, eventTenantId: input.tenantId }, "The book belongs to another tenant than the notification; trading decides");
      }

      const state = quotingStateOf(book, clock.now());
      if (state.kind === "stopped") {
        logger.info({ ...fields, reason: state.reason }, "Market is not quoted any more");
        return { kind: "stopped", reason: state.reason };
      }
      if (state.kind === "not_ready") {
        logger.info({ ...fields, reason: state.reason }, "Market is not ready to be quoted");
        return { kind: "not_ready", reason: state.reason };
      }

      const pricing: PricingInput = {
        holdings: book.holdings,
        fundingMicro: state.fundingMicro,
        startingPriceMicro: state.startingPriceMicro,
        maxOffersPerSide: state.maxOffersPerSide,
      };
      let desired: Offer[];
      let referencePriceMicro: number | null;
      try {
        desired = computeOffers(pricing, settings);
        referencePriceMicro = referencePriceOf(pricing);
      } catch (error) {
        // Input outside trading's contract or settings outside their ranges: a defect, isolated to this market so a
        // periodic check goes on with the others. The settings are range-checked when they are loaded, so this is
        // reached only by a book trading should never have sent.
        if (!(error instanceof DomainError)) throw error;
        logger.error({ ...fields, code: error.code, detail: error.message }, "The offers could not be computed");
        return { kind: "refused", status: 0, code: error.code, detail: error.message };
      }

      // The same rules trading applies to a PUT: a list that fails them is a defect of the pricing, never sent.
      const violations = offerViolations(desired, book.holdings, state.maxOffersPerSide);
      if (violations.length > 0) {
        const detail = violations.join("; ");
        logger.error({ ...fields, referencePriceMicro, offers: desired.length, detail }, "The computed offers break trading's rules and were not sent");
        return { kind: "refused", status: 0, code: "invariant_violated", detail };
      }

      // An empty book has no priced-on sequence, so an empty desired list is "unchanged" only against an empty book;
      // otherwise an equal list priced on an older sequence is sent again, so the book carries the current one.
      if (sameOffers(desired, book.offers) && (desired.length === 0 || book.offersPricedOnSequence === book.tradeSequence)) {
        logger.debug({ ...fields, referencePriceMicro, offers: book.offers.length }, "Offers unchanged");
        return { kind: "unchanged", tradeSequence: book.tradeSequence };
      }

      // Priced on the book's trade sequence, never on its offersPricedOnSequence (a fill keeps that one).
      const request: ReplaceOffersRequest = { basedOnSequence: book.tradeSequence, offers: desired };
      const result = await trading.replaceBotOrders(input.marketId, request, context);
      switch (result.kind) {
        case "replaced":
          logger.info({ ...fields, referencePriceMicro, offers: desired.length, attempts: attempt }, "Offers replaced");
          return { kind: "quoted", tradeSequence: book.tradeSequence, offers: desired.length, attempts: attempt };
        case "market_not_open":
          logger.info({ ...fields, reason: "market_not_open" }, "Market is not quoted any more");
          return { kind: "stopped", reason: "market_not_open" };
        case "not_found":
          logger.warn(fields, "Market not found");
          return { kind: "not_found" };
        case "refused":
          logger.error({ ...fields, status: result.status, code: result.code, detail: result.detail }, "trading refused the offers");
          return { kind: "refused", status: result.status, code: result.code, detail: result.detail };
        case "stale_sequence":
          logger.debug({ ...fields, attempt, currentSequence: result.tradeSequence }, "A trade happened since the read");
          // The wait is for the next attempt only: after the last one the run ends without sleeping.
          if (attempt < STALE_RETRY_ATTEMPTS) await delay.sleep(staleRetryDelayMs(attempt, random));
          break;
      }
    }

    logger.warn({ ...base, attempts: STALE_RETRY_ATTEMPTS }, "Gave up after repeated stale trade sequences");
    return { kind: "contended", attempts: STALE_RETRY_ATTEMPTS };
  }
}
