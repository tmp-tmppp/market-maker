import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  ExponentialBackoff,
  IsolatedCircuitError,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
} from "cockatiel";
import type { IPolicy } from "cockatiel";
import { TRADING_RETRY_MAX_DELAY_MS } from "../../config.js";
import type { TradingPolicyConfig } from "../../config.js";
import type { BotBook } from "../../domain/book.js";
import { TradingContractViolation, TradingUnavailable } from "../../usecases/errors.js";
import type { CallContext, Logger, OpenMarketsPage, ReplaceOffersRequest, ReplaceResult, TradingClient } from "../../usecases/ports.js";
import { TokenUnavailable } from "./token-provider.js";
import type { AccessTokenSource } from "./token-provider.js";
import { PROBLEM_DETAIL_MAX_LENGTH, parseBotBook, parseOpenMarketsPage, problemOf } from "./trading-bodies.js";

export interface TradingHttpClientOptions {
  /** Base URL of trading's internal port, for example http://trading:8081. */
  baseUrl: string;
  tokens: AccessTokenSource;
  policy: TradingPolicyConfig;
  logger: Logger;
  fetch?: typeof fetch;
  /** First and largest wait between two attempts of a read (exponential backoff with jitter). Defaults 250 and 2000. */
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
}

const OPEN_MARKETS_PATH = "/v1/internal/markets";
/** trading takes a correlation id of these characters and makes its own for any other (so does this client). */
const CORRELATION_ID_MAX_LENGTH = 128;

/** A status that says "try again": the same call may succeed a moment later (408, 429, 5xx). */
class TransientStatus extends Error {
  constructor(readonly status: number) {
    super(`trading answered ${status}`);
    this.name = "TransientStatus";
  }
}

/** The request or the reading of the answer did not complete: the network failed, or the time ran out. */
class TransportFailure extends Error {
  constructor(
    readonly reason: "timeout" | "network",
    options?: ErrorOptions,
  ) {
    super(reason === "timeout" ? "trading did not answer in time" : "trading cannot be reached", options);
    this.name = "TransportFailure";
  }
}

/** Worth another attempt of a read, and a failure that counts towards the circuit: trading was not reached or cannot take the call now. */
const isTransient = (error: unknown): boolean => error instanceof TransientStatus || error instanceof TransportFailure || error instanceof TaskCancelledError;

function transportFailure(error: unknown): TransportFailure {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new TransportFailure(timedOut ? "timeout" : "network", { cause: error });
}

/** The error code of a refused connection and the like (ECONNREFUSED), which fetch hides one level down. */
function networkCode(error: TransportFailure): string {
  const cause: unknown = error.cause;
  const inner: unknown = typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : cause;
  const code = typeof inner === "object" && inner !== null && "code" in inner ? inner.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "network error";
}

/** A short description of a failure for a log line. Never holds a token, a body or a URL. */
function describeFailure(error: unknown): string {
  if (error instanceof TransientStatus) return error.message;
  if (error instanceof TaskCancelledError || (error instanceof TransportFailure && error.reason === "timeout")) return "trading did not answer in time";
  if (error instanceof TransportFailure) return `trading cannot be reached (${networkCode(error)})`;
  return error instanceof Error ? error.name : "unknown failure";
}

/** What one attempt found out, as a value, so that every answer of trading reaches the circuit as a success. */
type Answer<T> = { kind: "value"; value: T } | { kind: "auth"; status: number } | { kind: "violation"; reason: string };

const value = <T>(result: T): Answer<T> => ({ kind: "value", value: result });
const violation = (reason: string): Answer<never> => ({ kind: "violation", reason });
const unexpectedStatus = (status: number): Answer<never> => violation(`trading answered the unexpected status ${status}`);

const discard = async (response: Response): Promise<void> => {
  await (response.body?.cancel() ?? Promise.resolve()).catch(() => undefined);
};

/** The text of an answer; a failure while it is read (a cut connection, the timeout) is a transport failure. */
async function textOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw transportFailure(error);
  }
}

function parsed<T>(text: string, parse: (body: unknown) => T): Answer<T> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return violation("the body is not JSON");
  }
  try {
    return value(parse(body));
  } catch (error) {
    if (error instanceof TradingContractViolation) return violation(error.message);
    throw error;
  }
}

/** The correlation id as a header value: only characters trading accepts, at most 128; null when nothing is left. */
function correlationHeader(correlationId: string): string | null {
  const clean = correlationId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, CORRELATION_ID_MAX_LENGTH);
  return clean === "" ? null : clean;
}

interface Operation<T> {
  /** For logs and messages, for example "GET bot-book". */
  label: string;
  method: "GET" | "PUT";
  /** Path with its query. */
  path: string;
  body?: string;
  policy: IPolicy;
  /** Turns an answer that is neither 401/403 nor transient into a value or a violation. */
  interpret(response: Response): Promise<Answer<T>>;
}

/**
 * TradingClient over trading's internal port (contracts/outgoing/trading-bot.openapi.yaml, ADR-041, plan REL-04): the
 * reads GET /v1/internal/markets and GET /v1/internal/markets/{id}/bot-book, and the replacement PUT
 * /v1/internal/markets/{id}/bot-orders, each with the service token of the client `market-maker`.
 *
 * One resilience policy set per instance: a timeout per attempt, a circuit breaker shared by all three calls
 * (consecutive failures; half-open after a wait), and for the two reads a retry with exponential backoff and jitter
 * outside the breaker. Only network errors, timeouts, 408, 429 and 5xx count as failures and are retried; every other
 * answer of trading is a result, so it tells the circuit that trading is up. The PUT is never retried here: a repeat
 * would carry offers priced on a book that may be stale, so the use case reads again and decides anew.
 *
 * Failures reach the use cases only as TradingUnavailable (scope "service" when every call would fail now: the circuit
 * is open, no service token, 401, 403; scope "call" otherwise, and `sent: false` when not one request of the call went
 * out, so the periodic check knows the market was never tried) and TradingContractViolation (an answer outside the
 * contract). Their messages never hold a token, a URL or a response body.
 */
export class TradingHttpClient implements TradingClient {
  private readonly baseUrl: string;
  private readonly http: typeof fetch;
  private readonly readPolicy: IPolicy;
  private readonly writePolicy: IPolicy;

  constructor(private readonly options: TradingHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? fetch;
    const { policy, logger } = options;
    const breaker = circuitBreaker(handleWhen(isTransient), {
      halfOpenAfter: policy.circuitHalfOpenMs,
      breaker: new ConsecutiveBreaker(policy.circuitFailures),
    });
    breaker.onBreak((reason) => {
      const failure = "error" in reason ? describeFailure(reason.error) : "isolated";
      logger.warn({ reason: failure, halfOpenAfterMs: policy.circuitHalfOpenMs }, "The circuit to trading opened");
    });
    breaker.onReset(() => logger.info({}, "The circuit to trading closed"));
    const attemptTimeout = timeout(policy.timeoutMs, TimeoutStrategy.Aggressive);
    const retries = retry(handleWhen(isTransient), {
      maxAttempts: policy.retries,
      backoff: new ExponentialBackoff({ initialDelay: options.retryInitialDelayMs ?? 250, maxDelay: options.retryMaxDelayMs ?? TRADING_RETRY_MAX_DELAY_MS }),
    });
    this.readPolicy = wrap(retries, breaker, attemptTimeout);
    this.writePolicy = wrap(breaker, attemptTimeout);
  }

  listOpenMarkets(page: { cursor: string | null; limit: number }, context: CallContext): Promise<OpenMarketsPage> {
    const query = new URLSearchParams({ status: "open", limit: String(page.limit) });
    if (page.cursor !== null) query.set("cursor", page.cursor);
    return this.send(
      {
        label: "GET open markets",
        method: "GET",
        path: `${OPEN_MARKETS_PATH}?${query.toString()}`,
        policy: this.readPolicy,
        interpret: async (response) => {
          if (response.status !== 200) {
            await discard(response);
            return unexpectedStatus(response.status);
          }
          return parsed(await textOf(response), parseOpenMarketsPage);
        },
      },
      context,
    );
  }

  getBotBook(marketId: string, context: CallContext): Promise<BotBook | null> {
    return this.send<BotBook | null>(
      {
        label: "GET bot-book",
        method: "GET",
        path: `${OPEN_MARKETS_PATH}/${encodeURIComponent(marketId)}/bot-book`,
        policy: this.readPolicy,
        interpret: async (response) => {
          if (response.status === 404) {
            await discard(response);
            return value(null);
          }
          if (response.status !== 200) {
            await discard(response);
            return unexpectedStatus(response.status);
          }
          return parsed(await textOf(response), parseBotBook);
        },
      },
      context,
    );
  }

  replaceBotOrders(marketId: string, request: ReplaceOffersRequest, context: CallContext): Promise<ReplaceResult> {
    // Only the fields of the contract: its request schema allows no others.
    const body = JSON.stringify({
      basedOnSequence: request.basedOnSequence,
      offers: request.offers.map((offer) => ({ side: offer.side, priceMicro: offer.priceMicro, sharesMicro: offer.sharesMicro })),
    });
    return this.send(
      {
        label: "PUT bot-orders",
        method: "PUT",
        path: `${OPEN_MARKETS_PATH}/${encodeURIComponent(marketId)}/bot-orders`,
        body,
        policy: this.writePolicy,
        interpret: (response) => this.interpretReplacement(response),
      },
      context,
    );
  }

  /** 200 the new book; 404; 400 and the 409 insufficient_holdings refused; the other 409 codes by name. */
  private async interpretReplacement(response: Response): Promise<Answer<ReplaceResult>> {
    const { status } = response;
    if (status === 200) {
      const answer = parsed(await textOf(response), parseBotBook);
      return answer.kind === "value" ? value({ kind: "replaced", book: answer.value }) : answer;
    }
    if (status === 404) {
      await discard(response);
      return value({ kind: "not_found" });
    }
    if (status !== 400 && status !== 409) {
      await discard(response);
      return unexpectedStatus(status);
    }
    const problem = problemOf(await textOf(response));
    const detail = (problem.detail ?? `trading answered ${status}`).slice(0, PROBLEM_DETAIL_MAX_LENGTH);
    if (status === 400) return value({ kind: "refused", status, code: problem.code, detail });
    switch (problem.code) {
      case "stale_sequence":
        return value({ kind: "stale_sequence", tradeSequence: problem.tradeSequence });
      case "market_not_open":
        return value({ kind: "market_not_open" });
      case "insufficient_holdings":
        return value({ kind: "refused", status, code: problem.code, detail });
      default:
        return violation(`trading answered 409 with the unexpected code ${problem.code ?? "(none)"}`);
    }
  }

  private async send<T>(operation: Operation<T>, context: CallContext): Promise<T> {
    const { logger } = this.options;
    const fields = { operation: operation.label, correlationId: context.correlationId };
    let attempts = 0;
    // True once a request of this call has been sent: a call rejected by an open circuit or for want of a token before
    // that never reached trading, which the periodic check needs to know (see `TradingUnavailable.sent`).
    let sent = false;
    let answer: Answer<T>;
    try {
      answer = await operation.policy.execute(async ({ signal }) => {
        attempts += 1;
        const token = await this.options.tokens.token();
        sent = true;
        const response = await this.attempt(operation, token, context, signal);
        return await this.judge(operation, response);
      });
    } catch (error) {
      throw this.failure(error, operation.label, sent);
    }
    if (attempts > 1) logger.debug({ ...fields, attempts }, "Trading answered after a retry");
    switch (answer.kind) {
      case "value":
        return answer.value;
      case "auth": {
        const refused = answer.status === 401 ? "refused the service token" : "does not admit the client";
        logger.warn({ ...fields, status: answer.status }, `Trading ${refused}`);
        throw new TradingUnavailable(`${operation.label}: trading ${refused} (${answer.status})`, { scope: "service" });
      }
      case "violation":
        throw new TradingContractViolation(`${operation.label}: ${answer.reason}`);
    }
  }

  /** One request. A redirect is an answer to look at, never to follow: it would carry the bearer token elsewhere. */
  private async attempt<T>(operation: Operation<T>, token: string, context: CallContext, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    const correlationId = correlationHeader(context.correlationId);
    if (correlationId !== null) headers["x-correlation-id"] = correlationId;
    if (operation.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.http(`${this.baseUrl}${operation.path}`, {
        method: operation.method,
        headers,
        ...(operation.body === undefined ? {} : { body: operation.body }),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw transportFailure(error);
    }
  }

  /** The statuses that mean the same for every call; the others go to the operation. */
  private async judge<T>(operation: Operation<T>, response: Response): Promise<Answer<T>> {
    const { status } = response;
    if (status === 401 || status === 403) {
      // The cached token may have been revoked: the next call fetches a new one. A 403 says the client is not admitted.
      if (status === 401) this.options.tokens.invalidate?.();
      await discard(response);
      return { kind: "auth", status };
    }
    if (status === 408 || status === 429 || status >= 500) {
      await discard(response);
      throw new TransientStatus(status);
    }
    return operation.interpret(response);
  }

  private failure(error: unknown, label: string, sent: boolean): TradingUnavailable | TradingContractViolation {
    // `sent: false` only when not one request of this call went out: a retry that finds the circuit open after an attempt
    // that was sent is a failure of that call, not a call that was never tried.
    const untried = sent ? {} : { sent: false };
    if (error instanceof BrokenCircuitError || error instanceof IsolatedCircuitError) {
      return new TradingUnavailable(`${label}: the circuit to trading is open`, { scope: "service", cause: error, ...untried });
    }
    if (error instanceof TokenUnavailable) {
      return new TradingUnavailable(`${label}: no service token for trading (${error.message})`, { scope: "service", cause: error, ...untried });
    }
    if (isTransient(error)) return new TradingUnavailable(`${label}: ${describeFailure(error)}`, { scope: "call", cause: error });
    // Not a failure of trading: a defect of this client. The name is kept, the message may say too much.
    return new TradingContractViolation(`${label}: unexpected failure (${error instanceof Error ? error.name : "unknown"})`, { cause: error });
  }
}
