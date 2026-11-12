import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

// The contract documents of the market maker and the copies of the other services' files (contracts/README.md), read
// from the files, never fetched: this repository is built on its own, so the copies are what the tests compare against
// (only the drift check against a sibling repository needs the sibling and is skipped without it). Helpers for the
// contract tests, and for any test that wants to validate a body against a schema.

export type Doc = Record<string, any>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const readText = (file: string): string => readFileSync(new URL(file, CONTRACTS), "utf8");
const read = (file: string): Doc => parse(readText(file)) as Doc;

/** What the bot expects of trading's internal API (a subset of trading's own file). */
export const outgoing = read("outgoing/trading-bot.openapi.yaml");
/** Copy of trading's internal OpenAPI file. */
export const tradingInternal = read("external/trading-internal.openapi.yaml");
/** The events the bot consumes. */
export const consumed = read("asyncapi.yaml");
/** Copies of the publishers' event contracts. */
export const tradingEvents = read("external/trading-asyncapi.yaml");
export const marketsEvents = read("external/markets-asyncapi.yaml");

export const EXTERNAL_COPIES = ["trading-internal.openapi.yaml", "trading-asyncapi.yaml", "markets-asyncapi.yaml"] as const;

/** Where each copy comes from, relative to this repository in the workspace (a sibling folder), and its README line. */
export const COPY_SOURCES: Record<(typeof EXTERNAL_COPIES)[number], string> = {
  "trading-internal.openapi.yaml": "../trading/contracts/internal.openapi.yaml",
  "trading-asyncapi.yaml": "../trading/contracts/asyncapi.yaml",
  "markets-asyncapi.yaml": "../markets/contracts/asyncapi.yaml",
};

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a file of contracts/external. */
export const copyBytes = (name: (typeof EXTERNAL_COPIES)[number]): Buffer => readFileSync(new URL(`external/${name}`, CONTRACTS));

/** The SHA-256 of a file of contracts/external. */
export const copyHash = (name: (typeof EXTERNAL_COPIES)[number]): string => sha256(copyBytes(name));

/** The text of contracts/README.md, where the hashes of the copies are recorded. */
export const readmeText = (): string => readText("README.md");

/** The hashes a contracts README text records for the copies, by file name (the file's own README unless a text is given). */
export function readmeHashes(readme: string = readmeText()): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const match of readme.matchAll(/\|\s*`external\/([^`]+)`\s*\|[^|]*\|\s*`([0-9a-f]{64})`\s*\|/g)) {
    hashes[match[1] ?? ""] = match[2] ?? "";
  }
  return hashes;
}

/** The bytes of the file a copy was made from, or null where the sibling repository is not beside this one. */
export function sourceOfCopy(name: (typeof EXTERNAL_COPIES)[number]): Buffer | null {
  const url = new URL(COPY_SOURCES[name], new URL("../../", import.meta.url));
  return existsSync(url) ? readFileSync(url) : null;
}

// OpenAPI 3.1 schemas are JSON Schema 2020-12; AsyncAPI 3.0 schemas default to a superset of draft-07.
const openapiAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(openapiAjv);
const asyncapiAjv = new Ajv({ strict: false, allErrors: true });
addFormats.default(asyncapiAjv);

const compiled = new WeakMap<Doc, Map<string, ValidateFunction>>();

/** A validator of `#/components/schemas/<name>` of a document, compiled once. */
function validatorOf(doc: Doc, name: string): ValidateFunction {
  let byName = compiled.get(doc);
  if (byName === undefined) compiled.set(doc, (byName = new Map()));
  let validate = byName.get(name);
  if (validate === undefined) {
    const ajv = doc["openapi"] !== undefined ? openapiAjv : asyncapiAjv;
    validate = ajv.compile({ components: doc["components"], $ref: `#/components/schemas/${name}` });
    byName.set(name, validate);
  }
  return validate;
}

const describeErrors = (errors: ReadonlyArray<{ instancePath: string; message?: string }> | null | undefined): string[] =>
  (errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`.trim());

/** Errors of a value against `#/components/schemas/<name>` of an OpenAPI or AsyncAPI document; empty = valid. */
export function schemaErrorsIn(doc: Doc, name: string, body: unknown): string[] {
  const validate = validatorOf(doc, name);
  return validate(body) ? [] : describeErrors(validate.errors);
}

export const botBookErrors = (body: unknown): string[] => schemaErrorsIn(tradingInternal, "BotBook", body);
export const botMarketPageErrors = (body: unknown): string[] => schemaErrorsIn(tradingInternal, "BotMarketPage", body);
export const replaceRequestErrors = (body: unknown): string[] => schemaErrorsIn(tradingInternal, "ReplaceBotOrdersRequest", body);
export const offerErrors = (body: unknown): string[] => schemaErrorsIn(tradingInternal, "Offer", body);

export const METHODS = ["get", "post", "put", "patch", "delete"];

/** "METHOD path" of every operation of an OpenAPI document. */
export function operationsOf(doc: Doc): Array<{ method: string; path: string; operation: Doc }> {
  return Object.entries(doc["paths"] as Record<string, Doc>).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]) => ({ method, path, operation: operation as Doc })),
  );
}

/** The statuses an operation documents, as numbers. */
export const documentedStatuses = (doc: Doc, path: string, method: string): number[] =>
  Object.keys(doc["paths"][path][method.toLowerCase()].responses as Record<string, unknown>).map(Number);

/** The node a local `$ref` ("#/components/...") points to; the node itself when it has none. */
export function deref(doc: Doc, node: Doc): Doc {
  if (typeof node?.["$ref"] !== "string") return node;
  const target = node["$ref"]
    .replace(/^#\//, "")
    .split("/")
    .reduce<any>((current, key) => current?.[key], doc);
  if (target === undefined) throw new Error(`Unresolvable reference ${String(node["$ref"])}`);
  return deref(doc, target);
}

// ---- Compatibility of the bot's expectation with trading's file ----

/** The keywords whose value must be the same in the bot's schema and in trading's. */
const SAME_KEYWORDS = ["type", "enum", "const", "format", "minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern", "additionalProperties"];

/**
 * What differs between a schema of the bot's contract and the same schema of trading's file, for every field the bot's
 * schema names: each keyword it sets must be equal, each property must exist at trading with a compatible schema, and
 * a property it requires must be required there too (the bot reads nothing trading may leave out).
 */
export function schemaDiffs(ours: Doc, ourSchema: Doc, theirs: Doc, theirSchema: Doc, path: string): string[] {
  const ourNode = deref(ours, ourSchema);
  const theirNode = deref(theirs, theirSchema);
  const diffs: string[] = [];
  for (const keyword of SAME_KEYWORDS) {
    if (keyword in ourNode && !isDeepStrictEqual(ourNode[keyword], theirNode[keyword])) {
      diffs.push(`${path}: ${keyword} is ${JSON.stringify(ourNode[keyword])} for the bot and ${JSON.stringify(theirNode[keyword])} at trading`);
    }
  }
  const theirRequired = (theirNode["required"] ?? []) as string[];
  for (const name of (ourNode["required"] ?? []) as string[]) {
    if (!theirRequired.includes(name)) diffs.push(`${path}.${name}: required by the bot, not required at trading`);
  }
  for (const [name, schema] of Object.entries((ourNode["properties"] ?? {}) as Record<string, Doc>)) {
    const theirProperty = theirNode["properties"]?.[name] as Doc | undefined;
    if (theirProperty === undefined) diffs.push(`${path}.${name}: not in trading's schema`);
    else diffs.push(...schemaDiffs(ours, schema, theirs, theirProperty, `${path}.${name}`));
  }
  if (ourNode["items"] !== undefined) {
    if (theirNode["items"] === undefined) diffs.push(`${path}[]: trading's schema has no items`);
    else diffs.push(...schemaDiffs(ours, ourNode["items"], theirs, theirNode["items"], `${path}[]`));
  }
  return diffs;
}

/** The media types of a response or request body, each with its schema. */
const contentOf = (doc: Doc, holder: Doc): Record<string, Doc> => (deref(doc, holder)["content"] ?? {}) as Record<string, Doc>;

/**
 * What differs between an operation of the bot's contract and the same operation of trading's file: operation id,
 * parameters, request body, the set of statuses, the media types and schemas of every answer.
 */
export function operationDiffs(ours: Doc, theirs: Doc, path: string, method: string): string[] {
  const label = `${method.toUpperCase()} ${path}`;
  const ourOp = ours["paths"][path]?.[method] as Doc | undefined;
  const theirOp = theirs["paths"][path]?.[method] as Doc | undefined;
  if (ourOp === undefined) return [`${label}: not in the bot's contract`];
  if (theirOp === undefined) return [`${label}: not in trading's file`];
  const diffs: string[] = [];
  if (ourOp["operationId"] !== theirOp["operationId"]) diffs.push(`${label}: operationId ${String(ourOp["operationId"])} against ${String(theirOp["operationId"])}`);

  for (const raw of (ourOp["parameters"] ?? []) as Doc[]) {
    const parameter = deref(ours, raw);
    const match = ((theirOp["parameters"] ?? []) as Doc[]).map((other) => deref(theirs, other)).find((other) => other["name"] === parameter["name"] && other["in"] === parameter["in"]);
    if (match === undefined) {
      diffs.push(`${label}: parameter ${String(parameter["name"])} is not in trading's file`);
      continue;
    }
    if (Boolean(parameter["required"]) !== Boolean(match["required"])) diffs.push(`${label}: parameter ${String(parameter["name"])} differs in required`);
    diffs.push(...schemaDiffs(ours, parameter["schema"], theirs, match["schema"], `${label} parameter ${String(parameter["name"])}`));
  }

  if (ourOp["requestBody"] !== undefined) {
    const ourBody = deref(ours, ourOp["requestBody"]);
    const theirBody = theirOp["requestBody"] === undefined ? undefined : deref(theirs, theirOp["requestBody"]);
    if (theirBody === undefined) diffs.push(`${label}: trading's operation has no request body`);
    else {
      if (Boolean(ourBody["required"]) !== Boolean(theirBody["required"])) diffs.push(`${label}: request body differs in required`);
      diffs.push(...contentDiffs(ours, contentOf(ours, ourBody), theirs, contentOf(theirs, theirBody), `${label} request`));
    }
  }

  const ourStatuses = Object.keys(ourOp["responses"]).sort();
  const theirStatuses = Object.keys(theirOp["responses"]).sort();
  if (!isDeepStrictEqual(ourStatuses, theirStatuses)) diffs.push(`${label}: statuses ${ourStatuses.join(",")} for the bot, ${theirStatuses.join(",")} at trading`);
  for (const status of ourStatuses) {
    const theirResponse = theirOp["responses"][status] as Doc | undefined;
    if (theirResponse === undefined) continue;
    diffs.push(...contentDiffs(ours, contentOf(ours, ourOp["responses"][status]), theirs, contentOf(theirs, theirResponse), `${label} ${status}`));
  }
  return diffs;
}

function contentDiffs(ours: Doc, ourContent: Record<string, Doc>, theirs: Doc, theirContent: Record<string, Doc>, label: string): string[] {
  const ourTypes = Object.keys(ourContent).sort();
  const theirTypes = Object.keys(theirContent).sort();
  if (!isDeepStrictEqual(ourTypes, theirTypes)) return [`${label}: media types ${ourTypes.join(",") || "none"} for the bot, ${theirTypes.join(",") || "none"} at trading`];
  return ourTypes.flatMap((type) => schemaDiffs(ours, ourContent[type]?.["schema"] as Doc, theirs, theirContent[type]?.["schema"] as Doc, `${label} ${type}`));
}

// ---- Examples built from a schema ----

export interface ExampleOptions {
  /** Values by property name, used wherever a property of that name appears (for a pattern no generator can satisfy). */
  overrides?: Record<string, unknown>;
}

const DATE_TIME_EXAMPLE = "2026-11-11T10:00:00.000Z";
const uuidExample = (n: number): string => `018f3c1e-7a00-7000-8000-${String(n).padStart(12, "0")}`;

/** `allOf` parts merged into one schema (properties and required lists joined, later keywords win). */
function mergeAllOf(doc: Doc, schema: Doc): Doc {
  const merged: Doc = {};
  const rest: Doc = { ...schema };
  delete rest["allOf"];
  for (const part of [...(schema["allOf"] as Doc[]), rest]) {
    const node = deref(doc, part);
    const flat = Array.isArray(node["allOf"]) ? mergeAllOf(doc, node) : node;
    // A property named in two parts keeps the keywords of both (the envelope's type and pattern, the event's const).
    const properties: Doc = { ...merged["properties"] };
    for (const [key, property] of Object.entries((flat["properties"] ?? {}) as Doc)) properties[key] = { ...properties[key], ...property };
    merged["properties"] = properties;
    merged["required"] = [...(merged["required"] ?? []), ...(flat["required"] ?? [])];
    for (const [key, entry] of Object.entries(flat)) if (key !== "properties" && key !== "required") merged[key] = entry;
  }
  return merged;
}

/**
 * Valid examples of a schema, enough to exercise a reader: a base example and, for each property, one example per
 * other value of that property (nullable ones as null, bounded integers at both bounds, every enum member, arrays
 * empty and with two items), and the variant with only the required properties. Deterministic. Every example is
 * checked against its schema by the caller (a generator that makes an invalid example fails that check, so a wrong
 * generator never hides a defect). A string whose pattern the generator cannot satisfy must be given in `overrides`.
 */
export function examplesOf(doc: Doc, schema: Doc, options: ExampleOptions = {}): unknown[] {
  const overrides = options.overrides ?? {};
  let counter = 0;

  const variantsOf = (node: Doc, name: string): unknown[] => {
    if (name in overrides) return [overrides[name]];
    const resolved = ((): Doc => {
      const target = deref(doc, node);
      return Array.isArray(target["allOf"]) ? mergeAllOf(doc, target) : target;
    })();
    if ("const" in resolved) return [resolved["const"]];
    if (Array.isArray(resolved["enum"])) return [...(resolved["enum"] as unknown[])];
    const declared = resolved["type"] ?? (resolved["properties"] === undefined ? undefined : "object");
    const types = (Array.isArray(declared) ? declared : [declared]) as string[];
    return types.flatMap((type) => variantsOfType(resolved, type, name));
  };

  const variantsOfType = (node: Doc, type: string, name: string): unknown[] => {
    switch (type) {
      case "null":
        return [null];
      case "boolean":
        return [true];
      case "integer":
      case "number": {
        const step = node["multipleOf"] as number | undefined;
        const minimum = (node["minimum"] as number | undefined) ?? (type === "integer" ? 1 : 0);
        const maximum = (node["maximum"] as number | undefined) ?? Number.MAX_SAFE_INTEGER;
        // A multiple of the step (or a whole number), as close to each bound as the schema allows.
        const low = step === undefined ? (type === "integer" ? Math.ceil(minimum) : minimum) : Math.ceil(minimum / step) * step;
        const top = step === undefined ? (type === "integer" ? Math.floor(maximum) : maximum) : Math.floor(maximum / step) * step;
        return top > low ? [low, top] : [low];
      }
      case "string": {
        if (node["format"] === "uuid") return [uuidExample(++counter)];
        if (node["format"] === "date-time") return [DATE_TIME_EXAMPLE];
        if (node["pattern"] !== undefined) throw new Error(`No example for the pattern of ${name}: give it in the overrides`);
        return ["x".repeat(Math.max((node["minLength"] as number | undefined) ?? 1, 1))];
      }
      case "array": {
        const items = variantsOf(node["items"] as Doc, name);
        const arrays: unknown[][] = [[items[0]], ...items.slice(1).map((item) => [item])];
        if (((node["minItems"] as number | undefined) ?? 0) === 0) arrays.push([]);
        if (items.length > 1) arrays.push([items[0], items[1]]);
        return arrays;
      }
      case "object": {
        const properties = Object.entries((node["properties"] ?? {}) as Record<string, Doc>);
        const options = properties.map(([key, property]) => [key, variantsOf(property, key)] as const);
        const base = Object.fromEntries(options.map(([key, values]) => [key, values[0]]));
        const examples: unknown[] = [base];
        for (const [key, values] of options) for (const other of values.slice(1)) examples.push({ ...base, [key]: other });
        const requiredKeys = new Set((node["required"] ?? []) as string[]);
        if (options.some(([key]) => !requiredKeys.has(key))) examples.push(Object.fromEntries(Object.entries(base).filter(([key]) => requiredKeys.has(key))));
        return examples;
      }
      default:
        throw new Error(`No example for the type ${type} of ${name}`);
    }
  };

  return variantsOf(schema, "");
}

/** Examples of `#/components/schemas/<name>` of a document. */
export const examplesOfSchema = (doc: Doc, name: string, options: ExampleOptions = {}): unknown[] => examplesOf(doc, { $ref: `#/components/schemas/${name}` }, options);
