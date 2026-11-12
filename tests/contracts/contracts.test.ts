import { describe, expect, it } from "vitest";
import { parseBotBook, parseOpenMarketsPage, problemOf } from "../../src/adapters/trading/trading-bodies.js";
import { TradingHttpClient } from "../../src/adapters/trading/trading-http-client.js";
import { CONSUMED_TYPES, readMarketNotice } from "../../src/domain/consumed.js";
import type { BotBook, BotMarket } from "../../src/domain/book.js";
import { computeOffers } from "../../src/domain/pricing.js";
import { TradingContractViolation } from "../../src/usecases/errors.js";
import type { OpenMarketsPage } from "../../src/usecases/ports.js";
import {
  COPY_SOURCES,
  EXTERNAL_COPIES,
  botBookErrors,
  botMarketPageErrors,
  consumed,
  copyBytes,
  copyHash,
  deref,
  examplesOfSchema,
  marketsEvents,
  offerErrors,
  operationDiffs,
  operationsOf,
  outgoing,
  readmeHashes,
  readmeText,
  replaceRequestErrors,
  schemaDiffs,
  schemaErrorsIn,
  sha256,
  sourceOfCopy,
  tradingEvents,
  tradingInternal,
} from "../support/contracts.js";
import type { Doc } from "../support/contracts.js";
import { MARKET_1, RecordingLogger, SeededRandom, credits } from "../support/fakes.js";

// The contracts of the market maker against the copies of the other services' files, and the code against both. The
// copies are read from contracts/external: the pipeline of this repository has no sibling folders, so every check but the
// drift check against a sibling runs there, and the drift check shows as skipped without one.

const OUTGOING_OPERATIONS = [
  { path: "/v1/internal/markets", method: "get", operationId: "listOpenMarkets" },
  { path: "/v1/internal/markets/{marketId}/bot-book", method: "get", operationId: "getBotBook" },
  { path: "/v1/internal/markets/{marketId}/bot-orders", method: "put", operationId: "replaceBotOrders" },
];
const SCHEMAS_THE_BOT_USES = ["Side", "BotMarket", "BotMarketPage", "Offer", "BotBook", "ReplaceBotOrdersRequest", "Problem"];

describe("the copies of the other services' contracts", () => {
  it("are the files the README records: every copy has a hash there and it is the file's SHA-256", () => {
    const recorded = readmeHashes();
    expect(Object.keys(recorded).sort()).toEqual([...EXTERNAL_COPIES].sort());
    for (const name of EXTERNAL_COPIES) expect(copyHash(name), `external/${name}`).toBe(recorded[name]);
  });

  it("notice a change: a copy that differs by one byte, or a README hash that differs by one digit, fails the comparison above", () => {
    const recorded = readmeHashes();
    for (const name of EXTERNAL_COPIES) {
      const edited = Buffer.concat([copyBytes(name), Buffer.from("\n")]);
      expect(sha256(edited), `${name} with one more byte`).not.toBe(recorded[name]);

      const wrong = (recorded[name] ?? "").replace(/^./, (digit) => (digit === "0" ? "1" : "0"));
      const tampered = readmeHashes(readmeText().replace(recorded[name] ?? "", wrong));
      expect(tampered[name], `${name}: the README line is still found`).toBe(wrong);
      expect(copyHash(name), `${name} against a README hash that was changed`).not.toBe(tampered[name]);
    }
  });

  // A drift check against the sibling repository: it needs that repository beside this one, so in a build of this
  // repository alone (the pipeline) it is skipped, and the hash test above is the check there.
  for (const name of EXTERNAL_COPIES) {
    const source = sourceOfCopy(name);
    it.skipIf(source === null)(`${name} equals its source in the sibling repository`, () => {
      expect(sha256(source as Buffer), `${name} drifted from ${COPY_SOURCES[name]}: copy it again and update the README hash`).toBe(copyHash(name));
    });
  }

  it("are an OpenAPI 3.1 file and two AsyncAPI 3.0 files", () => {
    expect(tradingInternal["openapi"]).toMatch(/^3\.1\./);
    expect(tradingEvents["asyncapi"]).toMatch(/^3\.0\./);
    expect(marketsEvents["asyncapi"]).toMatch(/^3\.0\./);
  });
});

describe("contracts/outgoing/trading-bot.openapi.yaml", () => {
  it("is OpenAPI 3.1 with a bearer scheme, the three operations the bot calls, unique operation ids and resolvable references", () => {
    expect(outgoing["openapi"]).toMatch(/^3\.1\./);
    expect(outgoing["components"].securitySchemes.serviceToken).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(outgoing["security"]).toEqual([{ serviceToken: [] }]);
    expect(
      operationsOf(outgoing)
        .map(({ method, path, operation }) => ({ path, method, operationId: operation["operationId"] }))
        .sort((a, b) => a.operationId.localeCompare(b.operationId)),
    ).toEqual([...OUTGOING_OPERATIONS].sort((a, b) => a.operationId.localeCompare(b.operationId)));

    const refs = [...JSON.stringify(outgoing).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], outgoing);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("documents the problem+json answer of every error status, and 503 with Retry-After on every operation", () => {
    expect(outgoing["components"].responses.ServiceUnavailable.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    for (const { method, path, operation } of operationsOf(outgoing)) {
      expect(operation["responses"]["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      for (const [status, response] of Object.entries(operation["responses"] as Record<string, Doc>)) {
        if (Number(status) < 400) continue;
        expect(Object.keys(deref(outgoing, response)["content"]), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
      }
    }
  });

  it("names trading's internal port as the server", () => {
    expect(outgoing["servers"][0].url).toBe("http://trading:8081");
  });

  describe.each(OUTGOING_OPERATIONS)("$method $path", ({ path, method }) => {
    it("is the same operation in trading's file: id, parameters, request body, statuses, media types and schemas", () => {
      expect(operationDiffs(outgoing, tradingInternal, path, method)).toEqual([]);
    });
  });

  it.each(SCHEMAS_THE_BOT_USES)("has the schema %s as trading's file has it, for every field the bot's schema names", (name) => {
    expect(outgoing["components"].schemas[name], `${name} in the bot's contract`).toBeDefined();
    expect(tradingInternal["components"].schemas[name], `${name} in trading's file`).toBeDefined();
    expect(schemaDiffs(outgoing, { $ref: `#/components/schemas/${name}` }, tradingInternal, { $ref: `#/components/schemas/${name}` }, name)).toEqual([]);
  });

  it("makes the comparison fail where the two files differ (the checker is checked)", () => {
    const changed = (edit: (copy: Doc) => void): Doc => {
      const copy = structuredClone(tradingInternal);
      edit(copy);
      return copy;
    };
    const ref = { $ref: "#/components/schemas/BotBook" };
    const diffsAgainst = (other: Doc) => schemaDiffs(outgoing, ref, other, ref, "BotBook");

    expect(diffsAgainst(changed((copy) => (copy["components"].schemas.BotBook.properties.maxOffersPerSide.maximum = 100)))).toEqual([
      expect.stringContaining("BotBook.maxOffersPerSide: maximum is 50 for the bot and 100 at trading"),
    ]);
    expect(diffsAgainst(changed((copy) => delete copy["components"].schemas.BotBook.properties.maxOffersPerSide))).toEqual(["BotBook.maxOffersPerSide: not in trading's schema"]);
    expect(diffsAgainst(changed((copy) => (copy["components"].schemas.BotBook.required = ["market"])))).toContain("BotBook.maxOffersPerSide: required by the bot, not required at trading");
    expect(diffsAgainst(changed((copy) => (copy["components"].schemas.BotMarket.properties.status.enum = ["open"])))).toEqual([expect.stringContaining("BotBook.market.status: enum")]);

    const operation = (edit: (copy: Doc) => void) => operationDiffs(outgoing, changed(edit), "/v1/internal/markets/{marketId}/bot-orders", "put");
    expect(operation((copy) => delete copy["paths"]["/v1/internal/markets/{marketId}/bot-orders"].put.responses["409"])).toEqual([expect.stringContaining("statuses")]);
    expect(operation((copy) => (copy["paths"]["/v1/internal/markets/{marketId}/bot-orders"].put.operationId = "other"))).toEqual([expect.stringContaining("operationId")]);
    expect(operation((copy) => delete copy["paths"]["/v1/internal/markets/{marketId}/bot-orders"].put.requestBody)).toEqual([expect.stringContaining("no request body")]);
    expect(operationDiffs(outgoing, changed((copy) => delete copy["paths"]["/v1/internal/markets"]), "/v1/internal/markets", "get")).toEqual(["GET /v1/internal/markets: not in trading's file"]);
  });
});

// ---- What the client reads ----

const iso = (market: BotMarket) => ({ ...market, closeTime: market.closeTime === null ? null : market.closeTime.toISOString() });
const bookBody = (book: BotBook) => ({ ...book, market: iso(book.market) });
const pageBody = (page: OpenMarketsPage) => ({ ...page, items: page.items.map(iso) });

describe.each([
  { file: "trading's internal OpenAPI file", doc: tradingInternal },
  { file: "the bot's outgoing contract", doc: outgoing },
])("the answers of $file", ({ doc }) => {
  const books = examplesOfSchema(doc, "BotBook");
  const pages = examplesOfSchema(doc, "BotMarketPage");

  it("are covered by a range of examples built from the schemas, every one valid against its schema", () => {
    expect(books.length).toBeGreaterThan(15);
    expect(pages.length).toBeGreaterThan(8);
    for (const example of books) expect(schemaErrorsIn(doc, "BotBook", example)).toEqual([]);
    for (const example of pages) expect(schemaErrorsIn(doc, "BotMarketPage", example)).toEqual([]);
  });

  it("are read by parseBotBook and parseOpenMarketsPage without losing or changing a field", () => {
    for (const example of books) expect(bookBody(parseBotBook(example))).toEqual(example);
    for (const example of pages) expect(pageBody(parseOpenMarketsPage(example))).toEqual(example);
  });

  it("are refused when a required field is missing, at the top and in the market", () => {
    const required = (name: string): string[] => deref(doc, doc["components"].schemas[name])["required"];
    for (const key of required("BotBook")) {
      const { [key]: _removed, ...without } = books[0] as Record<string, unknown>;
      expect(() => parseBotBook(without), `BotBook without ${key}`).toThrow(TradingContractViolation);
    }
    for (const key of required("BotMarket")) {
      const book = books[0] as { market: Record<string, unknown> };
      const { [key]: _removed, ...market } = book.market;
      expect(() => parseBotBook({ ...book, market }), `BotMarket without ${key}`).toThrow(TradingContractViolation);
    }
    for (const key of required("BotMarketPage")) {
      const { [key]: _removed, ...without } = pages[0] as Record<string, unknown>;
      expect(() => parseOpenMarketsPage(without), `BotMarketPage without ${key}`).toThrow(TradingContractViolation);
    }
  });

  it("have problem bodies that problemOf reads: the code, the detail (or the title) and the trade sequence", () => {
    const problems = examplesOfSchema(doc, "Problem");
    expect(problems.length).toBeGreaterThan(3);
    for (const example of problems as Array<Record<string, unknown>>) {
      expect(schemaErrorsIn(doc, "Problem", example)).toEqual([]);
      expect(problemOf(JSON.stringify(example))).toEqual({
        code: example["code"] ?? null,
        detail: example["detail"] ?? example["title"] ?? null,
        tradeSequence: example["tradeSequence"] ?? null,
      });
    }
  });
});

// ---- What the client sends ----

/** Random books over the whole range of fundings, starting prices, holdings, spreads and limits: the pricing's input. */
function randomOffers(count: number) {
  const random = new SeededRandom(20_261_111);
  return Array.from({ length: count }, () => {
    const fundingMicro = credits(random.int(1, 100_000));
    const holdings = { balanceMicro: random.int(0, fundingMicro), yesMicro: random.int(0, 2 * fundingMicro), noMicro: random.int(0, 2 * fundingMicro) };
    const input = { holdings, fundingMicro, startingPriceMicro: random.int(1, 99) * 10_000, maxOffersPerSide: random.int(1, 50) };
    return computeOffers(input, { spreadMicro: random.int(2, 20) * 10_000, levels: random.int(1, 10) });
  });
}

describe("the offers the bot sends", () => {
  const lists = randomOffers(250);

  it("are offers of the contract: every offer the pricing returns over random books validates against Offer, in both files", () => {
    expect(lists.some((offers) => offers.length > 0)).toBe(true);
    for (const offers of lists) {
      for (const offer of offers) {
        expect(offerErrors(offer), JSON.stringify(offer)).toEqual([]);
        expect(schemaErrorsIn(outgoing, "Offer", offer), JSON.stringify(offer)).toEqual([]);
      }
    }
  });

  it("are a request body of the contract: the PUT body the client sends validates against ReplaceBotOrdersRequest of trading's file", async () => {
    const bodies: unknown[] = [];
    const answer = JSON.stringify(examplesOfSchema(tradingInternal, "BotBook")[0]);
    const fetchStub = ((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(new Response(answer, { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    const client = new TradingHttpClient({
      baseUrl: "http://trading.test:8081",
      tokens: { token: () => Promise.resolve("service-token") },
      policy: { timeoutMs: 1000, retries: 0, circuitFailures: 5, circuitHalfOpenMs: 10_000 },
      logger: new RecordingLogger(),
      fetch: fetchStub,
    });

    let sequence = 0;
    for (const offers of [[], ...lists]) {
      await client.replaceBotOrders(MARKET_1, { basedOnSequence: sequence, offers }, { correlationId: "corr" });
      sequence += 7;
    }
    expect(bodies).toHaveLength(lists.length + 1);
    for (const body of bodies) {
      expect(replaceRequestErrors(body), JSON.stringify(body)).toEqual([]);
      expect(schemaErrorsIn(outgoing, "ReplaceBotOrdersRequest", body)).toEqual([]);
    }
  });

  it("are refused by the validators where they break the contract (the validators are checked)", () => {
    expect(offerErrors({ side: "YES", priceMicro: 520_000, sharesMicro: 1 })).toEqual([]);
    expect(offerErrors({ side: "YES", priceMicro: 525_000, sharesMicro: 1 })).not.toEqual([]);
    expect(offerErrors({ side: "MAYBE", priceMicro: 520_000, sharesMicro: 1 })).not.toEqual([]);
    expect(offerErrors({ side: "NO", priceMicro: 520_000, sharesMicro: 0 })).not.toEqual([]);
    expect(offerErrors({ side: "NO", priceMicro: 520_000, sharesMicro: 1, note: "x" })).not.toEqual([]);
    expect(replaceRequestErrors({ basedOnSequence: 1, offers: [], extra: true })).not.toEqual([]);
    expect(replaceRequestErrors({ basedOnSequence: -1, offers: [] })).not.toEqual([]);
    expect(replaceRequestErrors({ offers: [] })).not.toEqual([]);
    expect(botBookErrors({})).not.toEqual([]);
    expect(botMarketPageErrors({ items: [] })).not.toEqual([]);
  });
});

// ---- The events ----

const SUBJECT = "market/018f3c1e-7a00-7000-8000-0000000000f1";
const OVERRIDES = { subject: SUBJECT, correlationid: "corr-9" };
type Event = Record<string, any>;

/** Every event schema of a publisher's file, by the name of its type: "MarketOpened" for MarketOpenedEvent. */
function eventSchemas(doc: Doc): string[] {
  return Object.keys(doc["components"].schemas as Record<string, unknown>).filter((name) => name.endsWith("Event"));
}

const CONSUMED_BY_NAME: Record<string, { type: string; kind: string; publisher: Doc; notification: string }> = {
  MarketOpenedEvent: { type: CONSUMED_TYPES[0], kind: "market_opened", publisher: marketsEvents, notification: "Notification" },
  MarketClosedEvent: { type: CONSUMED_TYPES[1], kind: "market_closed", publisher: marketsEvents, notification: "Notification" },
  MarketResolvedEvent: { type: CONSUMED_TYPES[2], kind: "market_resolved", publisher: marketsEvents, notification: "Notification" },
  TradeExecutedEvent: { type: CONSUMED_TYPES[3], kind: "trade_executed", publisher: tradingEvents, notification: "TradeNotification" },
};

describe("contracts/asyncapi.yaml", () => {
  it("is AsyncAPI 3.0 and lists exactly the types the code consumes, one receive operation and one channel each", () => {
    expect(consumed["asyncapi"]).toMatch(/^3\.0\./);
    expect(consumed["components"].schemas.Notification.properties.type.enum).toEqual([...CONSUMED_TYPES]);

    const addresses = Object.values(consumed["channels"] as Record<string, { address: string }>).map((channel) => channel.address).sort();
    // si.chance.<service>.<Event>.v1 travels on chance.<service>.<Event>.<tenantId>.
    const expected = CONSUMED_TYPES.map((type) => `${type.replace(/^si\./, "").replace(/\.v\d+$/, "")}.{tenantId}`).sort();
    expect(addresses).toEqual(expected);

    const actions = Object.values(consumed["operations"] as Record<string, { action: string }>).map((operation) => operation.action);
    expect(actions).toEqual(["receive", "receive", "receive", "receive"]);
    expect(Object.keys(consumed["components"].messages).sort()).toEqual(["MarketClosed", "MarketOpened", "MarketResolved", "TradeExecuted"]);
  });

  it("consumes channels that the publishers' files publish on", () => {
    const published = (doc: Doc) => Object.values(doc["channels"] as Record<string, { address: string }>).map((channel) => channel.address);
    const all = [...published(marketsEvents), ...published(tradingEvents)];
    for (const channel of Object.values(consumed["channels"] as Record<string, { address: string }>)) {
      expect(all, channel.address).toContain(channel.address);
    }
  });

  it("asks of an event only attributes that both publishers require in their envelopes", () => {
    // The attributes readMarketNotice reads: type, id, time, tenantid, correlationid and the market from subject.
    const attributes = ["specversion", "id", "type", "subject", "time", "tenantid", "correlationid"];
    for (const [name, doc] of [["markets", marketsEvents], ["trading", tradingEvents]] as const) {
      const required = doc["components"].schemas.CloudEventEnvelope.required as string[];
      for (const attribute of attributes) expect(required, `${name}: ${attribute}`).toContain(attribute);
    }
    const asked = consumed["components"].schemas.Notification.required as string[];
    for (const attribute of asked) expect(attributes).toContain(attribute);
  });

  it("reads TradeExecuted's tradeSequence as trading defines it, and no other field of data", () => {
    const own = consumed["components"].schemas.TradeNotification.allOf[1].properties.data.properties;
    expect(Object.keys(own)).toEqual(["tradeSequence"]);
    const theirs = tradingEvents["components"].schemas.TradeExecutedData.properties.tradeSequence;
    expect(own.tradeSequence).toMatchObject({ type: theirs.type, minimum: theirs.minimum });
  });
});

describe("the events of the publishers' files", () => {
  const consumedNames = Object.keys(CONSUMED_BY_NAME);

  it("cannot be built without a subject: no example for its pattern, so a change of it is noticed", () => {
    expect(() => examplesOfSchema(tradingEvents, "TradeExecutedEvent")).toThrow(/pattern of subject/);
  });

  it.each(consumedNames)("%s: every example validates against the publisher's schema and the bot's notification, and readMarketNotice reads it", (name) => {
    const { type, kind, publisher, notification } = CONSUMED_BY_NAME[name] as (typeof CONSUMED_BY_NAME)[string];
    const examples = examplesOfSchema(publisher, name, { overrides: OVERRIDES }) as Event[];
    expect(examples.length).toBeGreaterThan(0);

    for (const event of examples) {
      expect(schemaErrorsIn(publisher, name, event)).toEqual([]);
      expect(schemaErrorsIn(consumed, notification, event)).toEqual([]);
      expect(event["type"]).toBe(type);
      expect(readMarketNotice(event)).toEqual({
        kind,
        eventId: event["id"],
        eventType: type,
        tenantId: event["tenantid"],
        marketId: SUBJECT.slice("market/".length),
        tradeSequence: kind === "trade_executed" ? event["data"]["tradeSequence"] : null,
        correlationId: "corr-9",
        time: new Date(event["time"]),
      });
    }
  });

  it("have the trade sequence of TradeExecuted read from data, at both ends of its range", () => {
    const examples = examplesOfSchema(tradingEvents, "TradeExecutedEvent", { overrides: OVERRIDES }) as Event[];
    const sequences = examples.map((event) => (readMarketNotice(event) as { tradeSequence: number }).tradeSequence);
    expect(sequences).toContain(1);
    expect(sequences).toContain(Number.MAX_SAFE_INTEGER);
  });

  it("are ignored, not read, when the publisher sends a type the bot does not consume", () => {
    // ConsumedEvent is trading's description of what it consumes, not an event it publishes.
    const others = [...eventSchemas(marketsEvents).map((name) => [name, marketsEvents] as const), ...eventSchemas(tradingEvents).map((name) => [name, tradingEvents] as const)].filter(
      ([name]) => !consumedNames.includes(name) && name !== "ConsumedEvent",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const [name, doc] of others) {
      for (const event of examplesOfSchema(doc, name, { overrides: OVERRIDES }) as Event[]) {
        expect(readMarketNotice(event), name).toMatchObject({ kind: "ignored", reason: expect.stringContaining("Unknown event type") as string });
      }
    }
  });

  it("are refused by the bot's notification schema where an attribute it reads is missing (the schema is checked)", () => {
    const [event] = examplesOfSchema(marketsEvents, "MarketOpenedEvent", { overrides: OVERRIDES }) as Event[];
    for (const attribute of ["id", "type", "subject", "tenantid", "specversion"]) {
      const { [attribute]: _removed, ...without } = event as Event;
      expect(schemaErrorsIn(consumed, "Notification", without), attribute).not.toEqual([]);
      expect(readMarketNotice(without), attribute).toMatchObject({ kind: "ignored" });
    }
    expect(schemaErrorsIn(consumed, "Notification", { ...event, subject: "withdrawal/x" })).not.toEqual([]);
  });
});
