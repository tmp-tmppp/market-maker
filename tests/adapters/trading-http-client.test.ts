import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { TokenUnavailable } from "../../src/adapters/trading/token-provider.js";
import type { AccessTokenSource } from "../../src/adapters/trading/token-provider.js";
import { parseBotBook, parseOpenMarketsPage } from "../../src/adapters/trading/trading-bodies.js";
import { TradingHttpClient } from "../../src/adapters/trading/trading-http-client.js";
import type { TradingPolicyConfig } from "../../src/config.js";
import { TradingContractViolation, TradingUnavailable } from "../../src/usecases/errors.js";
import type { Offer } from "../../src/domain/offers.js";
import type { CallContext } from "../../src/usecases/ports.js";
import { documentedStatuses, outgoing } from "../support/contracts.js";
import { MARKET_1, MARKET_2, RecordingLogger, TENANT_A } from "../support/fakes.js";

// The client against an injected fetch (every status of the three endpoints, the retries, the circuit, the token) and,
// at the end, against a real HTTP server (the wire format, redirects, timeouts, a refused connection).

const TOKEN = "service-token-abc";
const BODY_SENTINEL = "BODY-SENTINEL-must-not-appear";
const CONTEXT: CallContext = { correlationId: "corr-1" };
const POLICY: TradingPolicyConfig = { timeoutMs: 500, retries: 2, circuitFailures: 50, circuitHalfOpenMs: 10_000 };

const marketJson = (marketId = MARKET_1) => ({
  marketId,
  tenantId: TENANT_A,
  status: "open",
  version: 2,
  closeTime: "2026-12-01T10:00:00.000Z",
  startingPriceMicro: 500_000,
  fundingMicro: 5_000_000_000,
  tradeSequence: 4,
});
const BOOK_JSON = {
  market: marketJson(),
  holdings: { balanceMicro: 0, yesMicro: 5_000_000_000, noMicro: 5_000_000_000 },
  offers: [{ side: "YES", priceMicro: 520_000, sharesMicro: 100_000_000 }],
  tradeSequence: 4,
  offersPricedOnSequence: 4,
  maxOffersPerSide: 10,
};
const PAGE_JSON = { items: [marketJson(MARKET_1), marketJson(MARKET_2)], nextCursor: "next-page" };
const OFFERS: Offer[] = [
  { side: "YES", priceMicro: 520_000, sharesMicro: 100_000_000 },
  { side: "NO", priceMicro: 520_000, sharesMicro: 100_000_000 },
];
const REQUEST = { basedOnSequence: 4, offers: OFFERS };

// ---- The fetch stub ----

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: RequestInit["redirect"];
}

/** What one fetch call does: answers, or fails (an Error is thrown as the rejection of fetch). */
type Answer = (init: RequestInit) => Response | Error | Promise<Response>;

const json =
  (status: number, body: unknown, type = "application/json"): Answer =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Answer =>
  json(status, { type: `urn:chance:problem:${code.replaceAll("_", "-")}`, title: "Problem", status, detail: `detail of ${code}`, code, ...extra }, "application/problem+json");
const text =
  (status: number, body: string): Answer =>
  () =>
    new Response(body, { status });
const empty =
  (status: number, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(null, { status, headers });
const fail =
  (error: Error = new TypeError("fetch failed")): Answer =>
  () =>
    error;
/** Never answers until the request is aborted: the timeout. */
const hang: Answer = (init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
  });

/** Answers in order; the last answer repeats for every further call. */
function stub(...answers: Answer[]) {
  const calls: Sent[] = [];
  const fetchStub = ((input: string, init: RequestInit = {}) => {
    calls.push({ url: input, method: init.method, headers: init.headers as Record<string, string>, body: init.body as string | undefined, redirect: init.redirect });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === undefined) return Promise.reject(new Error("no answer defined"));
    const result = answer(init);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

interface SpyTokens extends AccessTokenSource {
  token: Mock<() => Promise<string>>;
  invalidate: Mock<() => void>;
}

const tokenSource = (): SpyTokens => ({ token: vi.fn(() => Promise.resolve(TOKEN)), invalidate: vi.fn<() => void>() });

function makeClient(answers: Answer[], policy: Partial<TradingPolicyConfig> = {}, tokens: SpyTokens = tokenSource(), baseUrl = "http://trading.test:8081") {
  const { fetch, calls } = stub(...answers);
  const logger = new RecordingLogger();
  const client = new TradingHttpClient({ baseUrl, tokens, policy: { ...POLICY, ...policy }, logger, fetch, retryInitialDelayMs: 1, retryMaxDelayMs: 5 });
  return { client, calls, logger, tokens };
}

const listPage = (client: TradingHttpClient) => client.listOpenMarkets({ cursor: null, limit: 100 }, CONTEXT);
const readBook = (client: TradingHttpClient) => client.getBotBook(MARKET_1, CONTEXT);
const replace = (client: TradingHttpClient) => client.replaceBotOrders(MARKET_1, REQUEST, CONTEXT);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The rejection of a promise (null when it resolves). */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

type Check = (promise: Promise<unknown>) => Promise<void>;
const resolvesTo =
  (expected: unknown): Check =>
  async (promise) => {
    expect(await promise).toEqual(expected);
  };
const unavailable =
  (scope: "service" | "call"): Check =>
  async (promise) => {
    const error = await rejection(promise);
    expect(error).toBeInstanceOf(TradingUnavailable);
    expect((error as TradingUnavailable).scope).toBe(scope);
  };
const violation: Check = async (promise) => {
  expect(await rejection(promise)).toBeInstanceOf(TradingContractViolation);
};

// ---- Every status of the contract, then the answers outside it ----

type Row = [status: number, answer: Answer, check: Check];

const LIST_DOCUMENTED: Row[] = [
  [200, json(200, PAGE_JSON), resolvesTo(parseOpenMarketsPage(PAGE_JSON))],
  [400, problem(400, "validation_failed"), violation],
  [401, problem(401, "unauthorized"), unavailable("service")],
  [403, problem(403, "forbidden"), unavailable("service")],
  [503, problem(503, "concurrent_update"), unavailable("call")],
];
const BOOK_DOCUMENTED: Row[] = [
  [200, json(200, BOOK_JSON), resolvesTo(parseBotBook(BOOK_JSON))],
  [400, problem(400, "validation_failed"), violation],
  [401, problem(401, "unauthorized"), unavailable("service")],
  [403, problem(403, "forbidden"), unavailable("service")],
  [404, problem(404, "not_found"), resolvesTo(null)],
  [503, problem(503, "concurrent_update"), unavailable("call")],
];
const PUT_DOCUMENTED: Row[] = [
  [200, json(200, BOOK_JSON), resolvesTo({ kind: "replaced", book: parseBotBook(BOOK_JSON) })],
  [400, problem(400, "crossed_offers"), resolvesTo({ kind: "refused", status: 400, code: "crossed_offers", detail: "detail of crossed_offers" })],
  [401, problem(401, "unauthorized"), unavailable("service")],
  [403, problem(403, "forbidden"), unavailable("service")],
  [404, problem(404, "not_found"), resolvesTo({ kind: "not_found" })],
  [409, problem(409, "stale_sequence", { tradeSequence: 9 }), resolvesTo({ kind: "stale_sequence", tradeSequence: 9 })],
  [503, problem(503, "concurrent_update"), unavailable("call")],
];

/** Statuses and bodies that are not in the contract, and what the client makes of them (for the reads and the PUT alike). */
const OUTSIDE_THE_CONTRACT: Array<[string, Answer, "call" | "violation"]> = [
  ["408", problem(408, "request_timeout"), "call"],
  ["429", problem(429, "too_many_requests"), "call"],
  ["500", text(500, "boom"), "call"],
  ["502", text(502, "<html>Bad Gateway</html>"), "call"],
  ["504", empty(504), "call"],
  ["204", empty(204), "violation"],
  ["301", empty(301, { location: "http://elsewhere.test/" }), "violation"],
  ["302", empty(302, { location: "http://elsewhere.test/" }), "violation"],
  ["304", empty(304), "violation"],
  ["418", problem(418, "teapot"), "violation"],
  ["422", problem(422, "unprocessable"), "violation"],
];

describe.each([
  { name: "GET /v1/internal/markets", path: "/v1/internal/markets", method: "get", rows: LIST_DOCUMENTED, call: listPage },
  { name: "GET /v1/internal/markets/{marketId}/bot-book", path: "/v1/internal/markets/{marketId}/bot-book", method: "get", rows: BOOK_DOCUMENTED, call: readBook },
  { name: "PUT /v1/internal/markets/{marketId}/bot-orders", path: "/v1/internal/markets/{marketId}/bot-orders", method: "put", rows: PUT_DOCUMENTED, call: replace },
])("$name", ({ path, method, rows, call }) => {
  it("is mapped for exactly the statuses the contract documents", () => {
    const mapped = [...new Set(rows.map(([status]) => status))].sort();
    expect(mapped).toEqual(documentedStatuses(outgoing, path, method).sort());
  });

  it.each(rows)("maps %i as the contract says", async (_status, answer, check) => {
    const { client } = makeClient([answer], { retries: 0 });
    await check(call(client));
  });

  it.each(OUTSIDE_THE_CONTRACT)("treats %s as trading being unavailable or as a contract violation", async (_name, answer, expected) => {
    const { client } = makeClient([answer], { retries: 0 });
    await (expected === "call" ? unavailable("call") : violation)(call(client));
  });

  it("refuses a 200 with a body that is not JSON, or does not fit the contract, as a contract violation that quotes none of it", async () => {
    for (const answer of [text(200, `not json ${BODY_SENTINEL}`), json(200, { unexpected: BODY_SENTINEL }), json(200, [])]) {
      const { client } = makeClient([answer], { retries: 0 });
      const error = await rejection(call(client));
      expect(error).toBeInstanceOf(TradingContractViolation);
      expect((error as Error).message).not.toContain(BODY_SENTINEL);
    }
  });
});

describe("GET /v1/internal/markets", () => {
  it("answers 404 as a contract violation: the path always exists", async () => {
    await violation(listPage(makeClient([problem(404, "not_found")]).client));
  });
});

describe("PUT bot-orders: the 409 and 400 answers", () => {
  it("reads stale_sequence with its trade sequence, and without one", async () => {
    const answers = [problem(409, "stale_sequence", { tradeSequence: 12 }), problem(409, "stale_sequence")];
    await resolvesTo({ kind: "stale_sequence", tradeSequence: 12 })(replace(makeClient([answers[0] as Answer]).client));
    await resolvesTo({ kind: "stale_sequence", tradeSequence: null })(replace(makeClient([answers[1] as Answer]).client));
  });

  it("reads market_not_open", async () => {
    await resolvesTo({ kind: "market_not_open" })(replace(makeClient([problem(409, "market_not_open", { status: "closed" })]).client));
  });

  it("refuses insufficient_holdings (a defect: the bot checks the backing) with trading's code and detail", async () => {
    const { client } = makeClient([problem(409, "insufficient_holdings", { side: "YES", offeredMicro: 5, availableMicro: 4 })]);
    await resolvesTo({ kind: "refused", status: 409, code: "insufficient_holdings", detail: "detail of insufficient_holdings" })(replace(client));
  });

  it.each([
    ["an unknown code", problem(409, "something_new")],
    ["no code", json(409, { title: "Conflict", status: 409 })],
    ["a body that is not JSON", text(409, "<html>conflict</html>")],
    ["a code that is not a plain word", json(409, { code: `Weird Code ${BODY_SENTINEL}`, status: 409 })],
  ])("treats a 409 with %s as a contract violation", async (_name, answer) => {
    const error = await rejection(replace(makeClient([answer]).client));
    expect(error).toBeInstanceOf(TradingContractViolation);
    expect((error as Error).message).not.toContain(BODY_SENTINEL);
  });

  it.each([
    ["validation_failed", problem(400, "validation_failed", { errors: [{ field: "offers", message: "too many" }] }), "validation_failed", "detail of validation_failed"],
    ["a body that is not JSON", text(400, "Bad Request"), null, "trading answered 400"],
    ["a title only", json(400, { title: "Bad Request", status: 400 }), null, "Bad Request"],
  ])("refuses a 400 with %s, whatever the body says", async (_name, answer, code, detail) => {
    await resolvesTo({ kind: "refused", status: 400, code, detail })(replace(makeClient([answer]).client));
  });

  it("sends once and keeps the detail short", async () => {
    const { client, calls } = makeClient([json(400, { code: "validation_failed", detail: "d".repeat(2000) })]);
    const result = await replace(client);
    expect(result).toMatchObject({ kind: "refused", code: "validation_failed" });
    expect((result as { detail: string }).detail).toHaveLength(200);
    expect(calls).toHaveLength(1);
  });
});

// ---- What is sent ----

describe("the requests", () => {
  it("lists with status=open, the limit and the cursor, a bearer token, accept and the correlation id", async () => {
    const { client, calls } = makeClient([json(200, PAGE_JSON)], {}, tokenSource(), "http://trading.test:8081///");
    await client.listOpenMarkets({ cursor: "a+b/c=", limit: 50 }, { correlationId: "corr-77" });
    await listPage(client);

    expect(calls[0]?.url).toBe("http://trading.test:8081/v1/internal/markets?status=open&limit=50&cursor=a%2Bb%2Fc%3D");
    expect(calls[1]?.url).toBe("http://trading.test:8081/v1/internal/markets?status=open&limit=100");
    expect(calls[0]).toMatchObject({
      method: "GET",
      body: undefined,
      redirect: "manual",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json", "x-correlation-id": "corr-77" },
    });
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
  });

  it("reads a book by the market id, path-encoded", async () => {
    const { client, calls } = makeClient([json(200, BOOK_JSON)]);
    await client.getBotBook("a/b?c#d", CONTEXT);
    expect(calls[0]?.url).toBe("http://trading.test:8081/v1/internal/markets/a%2Fb%3Fc%23d/bot-book");
    expect(calls[0]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("replaces with a PUT that carries exactly basedOnSequence and the offers, as JSON", async () => {
    const { client, calls } = makeClient([json(200, BOOK_JSON)]);
    const extra = { ...OFFERS[0], note: "not in the contract" } as Offer;
    await client.replaceBotOrders(MARKET_1, { basedOnSequence: 4, offers: [extra, OFFERS[1] as Offer], ignored: true } as never, CONTEXT);

    expect(calls[0]).toMatchObject({ method: "PUT", url: `http://trading.test:8081/v1/internal/markets/${MARKET_1}/bot-orders`, redirect: "manual" });
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: "application/json", "content-type": "application/json", "x-correlation-id": "corr-1" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ basedOnSequence: 4, offers: OFFERS });
  });

  it("sends an empty list to cancel every offer", async () => {
    const { client, calls } = makeClient([json(200, { ...BOOK_JSON, offers: [], offersPricedOnSequence: null })]);
    await expect(client.replaceBotOrders(MARKET_1, { basedOnSequence: 0, offers: [] }, CONTEXT)).resolves.toMatchObject({ kind: "replaced" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ basedOnSequence: 0, offers: [] });
  });

  it.each([
    ["corr 1\r\nx-evil: 1", "corr_1__x-evil:_1"],
    ["plain.id:7_a-b", "plain.id:7_a-b"],
    ["€", "_"],
    ["a".repeat(300), "a".repeat(128)],
  ])("sends the correlation id %j as a header trading accepts: %j", async (correlationId, header) => {
    const { client, calls } = makeClient([json(200, BOOK_JSON)]);
    await client.getBotBook(MARKET_1, { correlationId });
    expect(calls[0]?.headers["x-correlation-id"]).toBe(header);
  });

  it("sends no correlation header for an empty id", async () => {
    const { client, calls } = makeClient([json(200, BOOK_JSON)]);
    await client.getBotBook(MARKET_1, { correlationId: "" });
    expect(calls[0]?.headers["x-correlation-id"]).toBeUndefined();
  });
});

// ---- Retries ----

const TRANSIENT_FAILURES: Array<[string, Answer]> = [
  ["a network error", fail()],
  ["a timeout", hang],
  ["408", problem(408, "request_timeout")],
  ["429", problem(429, "too_many_requests")],
  ["500", text(500, "boom")],
  ["502", empty(502)],
  ["503", problem(503, "concurrent_update")],
];

describe("retries", () => {
  describe.each([
    ["the open markets", listPage, json(200, PAGE_JSON), parseOpenMarketsPage(PAGE_JSON)],
    ["a book", readBook, json(200, BOOK_JSON), parseBotBook(BOOK_JSON)],
  ] as const)("on a read of %s", (_name, call, success, expected) => {
    it.each(TRANSIENT_FAILURES)("repeats after %s and returns the answer of the second attempt", async (_failure, failure) => {
      const { client, calls, tokens } = makeClient([failure, success], { timeoutMs: 40 });
      expect(await call(client)).toEqual(expected);
      expect(calls).toHaveLength(2);
      // A token is asked for before every attempt, so a refreshed one is used by the repeat.
      expect(tokens.token).toHaveBeenCalledTimes(2);
    });

    it.each(TRANSIENT_FAILURES)("makes 1 + retries attempts when %s never goes away, then reports trading as unavailable (scope call)", async (_failure, failure) => {
      const { client, calls } = makeClient([failure], { timeoutMs: 30, retries: 2 });
      await unavailable("call")(call(client));
      expect(calls).toHaveLength(3);
    });

    it("makes one attempt when retries is 0, and 4 when it is 3", async () => {
      const once = makeClient([problem(503, "concurrent_update")], { retries: 0 });
      await unavailable("call")(call(once.client));
      expect(once.calls).toHaveLength(1);
      const four = makeClient([problem(503, "concurrent_update")], { retries: 3 });
      await unavailable("call")(call(four.client));
      expect(four.calls).toHaveLength(4);
    });

    it.each([
      ["400", problem(400, "validation_failed")],
      ["401", problem(401, "unauthorized")],
      ["403", problem(403, "forbidden")],
      ["204", empty(204)],
      ["302", empty(302, { location: "http://elsewhere.test/" })],
      ["a 200 with a body that breaks the contract", json(200, { unexpected: true })],
    ])("does not repeat after %s", async (_name, answer) => {
      const { client, calls } = makeClient([answer, success]);
      await rejection(call(client));
      expect(calls).toHaveLength(1);
    });
  });

  it.each(TRANSIENT_FAILURES)("never repeats a PUT after %s: one attempt per call, the use case reads the book again", async (_failure, failure) => {
    const { client, calls, tokens } = makeClient([failure, json(200, BOOK_JSON)], { timeoutMs: 40 });
    await unavailable("call")(replace(client));
    expect(calls).toHaveLength(1);
    expect(tokens.token).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a book that answers 404 and returns null at once", async () => {
    const { client, calls } = makeClient([problem(404, "not_found"), json(200, BOOK_JSON)]);
    expect(await readBook(client)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// ---- The circuit ----

describe("the circuit breaker", () => {
  const SERVER_ERROR = problem(503, "concurrent_update");

  it("opens after circuitFailures consecutive failures, then fails fast without a request or a token (scope service)", async () => {
    const { client, calls, tokens, logger } = makeClient([SERVER_ERROR], { retries: 0, circuitFailures: 3 });
    for (let i = 0; i < 3; i += 1) await unavailable("call")(replace(client));
    expect(logger.messages("warn")).toContain("The circuit to trading opened");

    for (const call of [replace, readBook, listPage]) {
      const error = await rejection(call(client));
      expect(error).toBeInstanceOf(TradingUnavailable);
      expect((error as TradingUnavailable).scope).toBe("service");
      expect((error as Error).message).toContain("circuit");
    }
    expect(calls).toHaveLength(3);
    expect(tokens.token).toHaveBeenCalledTimes(3);
  });

  it("is shared by the reads and the PUT", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 0, circuitFailures: 2 });
    await unavailable("call")(readBook(client));
    await unavailable("call")(listPage(client));
    await unavailable("service")(replace(client));
    expect(calls).toHaveLength(2);
  });

  it("opens in the middle of a retry run, which then stops with scope service", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 5, circuitFailures: 3 });
    await unavailable("service")(readBook(client));
    expect(calls).toHaveLength(3);
  });

  it("counts the attempts of a read that is retried", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 2, circuitFailures: 3 });
    await unavailable("call")(readBook(client));
    expect(calls).toHaveLength(3);
    await unavailable("service")(readBook(client));
    expect(calls).toHaveLength(3);
  });

  it("closes again after the wait: one call goes through, and its success closes it", async () => {
    const { client, calls, logger } = makeClient([SERVER_ERROR, SERVER_ERROR, json(200, BOOK_JSON)], { retries: 0, circuitFailures: 2, circuitHalfOpenMs: 40 });
    await unavailable("call")(readBook(client));
    await unavailable("call")(readBook(client));
    await unavailable("service")(readBook(client));
    await sleep(80);
    expect(await readBook(client)).toEqual(parseBotBook(BOOK_JSON));
    expect(await readBook(client)).toEqual(parseBotBook(BOOK_JSON));
    expect(calls).toHaveLength(4);
    expect(logger.messages("info")).toContain("The circuit to trading closed");
  });

  it("opens again when the call after the wait fails", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 0, circuitFailures: 1, circuitHalfOpenMs: 40 });
    await unavailable("call")(readBook(client));
    await unavailable("service")(readBook(client));
    await sleep(80);
    await unavailable("call")(readBook(client));
    await unavailable("service")(readBook(client));
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a 404 (a book that does not exist)", problem(404, "not_found")],
    ["a 401", problem(401, "unauthorized")],
    ["a 403", problem(403, "forbidden")],
    ["a 400", problem(400, "validation_failed")],
    ["a 200 that breaks the contract", json(200, { unexpected: true })],
    ["a book", json(200, BOOK_JSON)],
  ])("does not count %s as a failure: it is an answer, so trading is up", async (_name, answer) => {
    const { client, calls } = makeClient([SERVER_ERROR, SERVER_ERROR, answer, SERVER_ERROR, SERVER_ERROR, json(200, BOOK_JSON)], { retries: 0, circuitFailures: 3 });
    for (let i = 0; i < 5; i += 1) await rejection(readBook(client));
    expect(await readBook(client)).toEqual(parseBotBook(BOOK_JSON));
    expect(calls).toHaveLength(6);
  });

  it("says whether a request of the call went out: sent is false for a call an open circuit rejects, undefined for one that was sent", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 2, circuitFailures: 3 });
    // The third attempt of the first call opens the circuit and is thrown as that call's own failure.
    expect(await rejection(readBook(client))).toMatchObject({ name: "TradingUnavailable", scope: "call", sent: undefined });
    for (const call of [readBook, listPage, replace]) {
      expect(await rejection(call(client))).toMatchObject({ name: "TradingUnavailable", scope: "service", sent: false });
    }
    expect(calls).toHaveLength(3);
  });

  it("leaves sent undefined when the circuit opens on a retry of a call whose first attempt went out", async () => {
    const { client, calls } = makeClient([SERVER_ERROR], { retries: 5, circuitFailures: 3 });
    expect(await rejection(readBook(client))).toMatchObject({ name: "TradingUnavailable", scope: "service", sent: undefined });
    expect(calls).toHaveLength(3);
  });

  it("says sent is false when there is no token before the first request, and leaves it undefined when the token fails on a retry", async () => {
    const noToken = tokenSource();
    noToken.token.mockRejectedValue(new TokenUnavailable("The token endpoint cannot be reached"));
    const first = makeClient([json(200, BOOK_JSON)], {}, noToken);
    expect(await rejection(readBook(first.client))).toMatchObject({ scope: "service", sent: false });
    expect(first.calls).toHaveLength(0);

    const lateToken = tokenSource();
    lateToken.token.mockResolvedValueOnce(TOKEN).mockRejectedValue(new TokenUnavailable("The token endpoint cannot be reached"));
    const second = makeClient([SERVER_ERROR], { retries: 2, circuitFailures: 50 }, lateToken);
    expect(await rejection(readBook(second.client))).toMatchObject({ scope: "service", sent: undefined });
    expect(second.calls).toHaveLength(1);
  });

  it("leaves sent undefined for a 401 and a 403 (a request went out)", async () => {
    for (const answer of [problem(401, "unauthorized"), problem(403, "forbidden")]) {
      const { client } = makeClient([answer]);
      expect(await rejection(readBook(client))).toMatchObject({ scope: "service", sent: undefined });
    }
  });

  it("is not opened by failures to get a token, and those never reach trading", async () => {
    const tokens = tokenSource();
    tokens.token.mockRejectedValue(new TokenUnavailable("The token endpoint cannot be reached"));
    const { client, calls } = makeClient([json(200, BOOK_JSON)], { circuitFailures: 2 }, tokens);
    for (let i = 0; i < 5; i += 1) await unavailable("service")(readBook(client));
    expect(calls).toHaveLength(0);

    tokens.token.mockResolvedValue(TOKEN);
    expect(await readBook(client)).toEqual(parseBotBook(BOOK_JSON));
    expect(calls).toHaveLength(1);
  });
});

// ---- The token ----

describe("the service token", () => {
  it("is forgotten on a 401, which is not repeated and ends a check (scope service); a 403 leaves it", async () => {
    const unauthorized = makeClient([problem(401, "unauthorized")]);
    await unavailable("service")(readBook(unauthorized.client));
    expect(unauthorized.tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(unauthorized.calls).toHaveLength(1);
    expect(unauthorized.logger.messages("warn")).toContain("Trading refused the service token");

    const forbidden = makeClient([problem(403, "forbidden")]);
    const error = await rejection(replace(forbidden.client));
    expect(error).toBeInstanceOf(TradingUnavailable);
    expect((error as Error).message).toContain("does not admit the client (403)");
    expect(forbidden.tokens.invalidate).not.toHaveBeenCalled();
    expect(forbidden.logger.messages("warn")).toContain("Trading does not admit the client");
  });

  it("works with a token source that cannot be invalidated", async () => {
    const { fetch } = stub(problem(401, "unauthorized"));
    const client = new TradingHttpClient({ baseUrl: "http://trading.test:8081", tokens: { token: () => Promise.resolve(TOKEN) }, policy: POLICY, logger: new RecordingLogger(), fetch });
    await unavailable("service")(readBook(client));
  });

  it("makes a missing token a TradingUnavailable with scope service: no request, no repeat, nothing of the secret", async () => {
    const tokens = tokenSource();
    tokens.token.mockRejectedValue(new TokenUnavailable("The token endpoint answered 401"));
    const { client, calls } = makeClient([json(200, BOOK_JSON)], {}, tokens);
    const error = await rejection(readBook(client));
    expect(error).toBeInstanceOf(TradingUnavailable);
    expect((error as TradingUnavailable).scope).toBe("service");
    expect((error as Error).message).toBe("GET bot-book: no service token for trading (The token endpoint answered 401)");
    expect(calls).toHaveLength(0);
    expect(tokens.token).toHaveBeenCalledTimes(1);
  });

  it("never appears in a log line or in the message of an error, whatever went wrong", async () => {
    const leaking = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const scenarios: Answer[] = [
      json(200, BOOK_JSON),
      problem(401, "unauthorized"),
      problem(403, "forbidden"),
      text(502, BODY_SENTINEL),
      text(200, `not json ${BODY_SENTINEL}`),
      problem(409, "something_new", { detail: BODY_SENTINEL }),
      fail(leaking),
      hang,
      empty(302, { location: `http://elsewhere.test/${BODY_SENTINEL}` }),
    ];
    for (const answer of scenarios) {
      const { client, logger } = makeClient([answer], { timeoutMs: 30, circuitFailures: 1 });
      for (const call of [readBook, listPage, replace]) {
        const error = await rejection(call(client));
        if (error !== null) {
          expect((error as Error).message).not.toContain(TOKEN);
          expect((error as Error).message).not.toContain(BODY_SENTINEL);
        }
      }
      const logged = JSON.stringify(logger.lines);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(BODY_SENTINEL);
    }
  });

  it("describes a refused connection by its code", async () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8081"), { code: "ECONNREFUSED" }) });
    const error = await rejection(readBook(makeClient([fail(refused)], { retries: 0 }).client));
    expect((error as Error).message).toBe("GET bot-book: trading cannot be reached (ECONNREFUSED)");
    const unknown = await rejection(readBook(makeClient([fail(new Error("weird"))], { retries: 0 }).client));
    expect((unknown as Error).message).toBe("GET bot-book: trading cannot be reached (network error)");
  });

  it("describes a timeout as such", async () => {
    const error = await rejection(readBook(makeClient([hang], { retries: 0, timeoutMs: 30 }).client));
    expect(error).toBeInstanceOf(TradingUnavailable);
    expect((error as Error).message).toBe("GET bot-book: trading did not answer in time");
  });
});

// ---- A real HTTP server ----

describe("against a real HTTP server", () => {
  interface Received {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingHttpHeaders;
    body: string;
  }

  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function serve(respond: (request: Received, reply: (status: number, body: unknown, headers?: Record<string, string>) => void) => void) {
    const received: Received[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const request: Received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        received.push(request);
        respond(request, (status, body, headers = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { received, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  const realClient = (baseUrl: string, policy: Partial<TradingPolicyConfig> = {}) =>
    new TradingHttpClient({ baseUrl, tokens: tokenSource(), policy: { ...POLICY, ...policy }, logger: new RecordingLogger(), retryInitialDelayMs: 1, retryMaxDelayMs: 5 });

  it("puts the documented request on the wire and reads the answer", async () => {
    const { received, baseUrl } = await serve((request, reply) => (request.method === "PUT" ? reply(200, BOOK_JSON) : reply(200, PAGE_JSON)));
    const client = realClient(baseUrl);

    expect(await client.listOpenMarkets({ cursor: "c1", limit: 25 }, CONTEXT)).toEqual(parseOpenMarketsPage(PAGE_JSON));
    expect(await client.replaceBotOrders(MARKET_1, REQUEST, CONTEXT)).toMatchObject({ kind: "replaced" });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ method: "GET", url: "/v1/internal/markets?status=open&limit=25&cursor=c1" });
    expect(received[0]?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, accept: "application/json", "x-correlation-id": "corr-1" });
    expect(received[1]).toMatchObject({ method: "PUT", url: `/v1/internal/markets/${MARKET_1}/bot-orders` });
    expect(received[1]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(received[1]?.body ?? "")).toEqual({ basedOnSequence: 4, offers: OFFERS });
  });

  it("does not follow a redirect: the token goes nowhere else and the answer is a contract violation", async () => {
    const elsewhere = await serve((_request, reply) => reply(200, BOOK_JSON));
    const trading = await serve((_request, reply) => reply(302, "", { location: `${elsewhere.baseUrl}/v1/internal/markets/${MARKET_1}/bot-book` }));
    const client = realClient(trading.baseUrl);

    for (const call of [readBook, listPage, replace]) await violation(call(client));
    expect(trading.received.length).toBeGreaterThanOrEqual(3);
    expect(elsewhere.received).toHaveLength(0);
  });

  it("gives up on a server that is too slow, repeats a read and not a PUT", async () => {
    const { received, baseUrl } = await serve((_request, reply) => setTimeout(() => reply(200, BOOK_JSON), 250));
    const client = realClient(baseUrl, { timeoutMs: 60, retries: 1 });

    await unavailable("call")(readBook(client));
    expect(received).toHaveLength(2);
    await unavailable("call")(replace(client));
    expect(received).toHaveLength(3);
  });

  it("reports a refused connection as trading being unavailable, with the error code", async () => {
    const probe = await serve((_request, reply) => reply(200, BOOK_JSON));
    const closedUrl = probe.baseUrl;
    const server = servers.pop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const error = await rejection(realClient(closedUrl, { retries: 0 }).getBotBook(MARKET_1, CONTEXT));
    expect(error).toBeInstanceOf(TradingUnavailable);
    expect((error as TradingUnavailable).scope).toBe("call");
    expect((error as Error).message).toBe("GET bot-book: trading cannot be reached (ECONNREFUSED)");
  });

  it("reads a book answered with 404 as null", async () => {
    const { baseUrl } = await serve((_request, reply) => reply(404, { type: "urn:chance:problem:not-found", title: "Not Found", status: 404, code: "not_found" }));
    expect(await realClient(baseUrl).getBotBook(MARKET_2, CONTEXT)).toBeNull();
  });
});
