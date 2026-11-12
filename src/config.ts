import { LEVELS_MAX, SPREAD_MICRO_MAX, SPREAD_MICRO_MIN } from "./domain/pricing.js";
import type { QuotingSettings } from "./usecases/ports.js";

// Typed configuration, validated once at startup. A bad or missing setting stops the start with a message that names
// every problem; values are never printed (the client secret is one of them).
// ADR-037: defaults, then the watched runtime file, then environment variables (the chart's ConfigMap and Secret), so
// an environment variable always wins. The runtime keys (RUNTIME_KEYS) are read here as their startup values; the
// watcher of RUNTIME_CONFIG_FILE (src/adapters/runtime-config.ts) applies the file with parseRuntimeFile while the
// service runs, without a restart, for every runtime key the environment does not set (the chart sets none there).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/** The client "market-maker" of the identity provider: the bot's service account for trading (client credentials). */
export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

/** The resilience policy of the calls to trading (cockatiel, one policy per process; REL-04). */
export interface TradingPolicyConfig {
  /** Per attempt. */
  timeoutMs: number;
  /** Retries after the first attempt of a read (GET), on network errors, timeouts, 408, 429 and 5xx; a PUT is never retried. */
  retries: number;
  /** Consecutive failures that open the circuit. */
  circuitFailures: number;
  /** How long the circuit stays open before one call may try again (half-open). */
  circuitHalfOpenMs: number;
}

/** The keys that may change while the service runs. */
export interface RuntimeSettings {
  logLevel: string;
  quoting: QuotingSettings;
}

export interface Config {
  /** "local" allows the fake trading client and running without NATS; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  /** The health probes; the bot has no other HTTP endpoint. */
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the probes' port. */
  metricsPort: number;
  /** Startup value of a runtime key. */
  logLevel: string;
  runtimeConfigFile: string | null;
  runtimeConfigPollMs: number;
  /** Null only in local mode: nothing is consumed then, and only the periodic check quotes. */
  natsUrl: string | null;
  /** trading's internal port (http://trading:8081). Null only in local mode: a fake trading client in memory answers. */
  tradingUrl: string | null;
  /** Null only in local mode without TRADING_URL. */
  keycloak: KeycloakConfig | null;
  tradingPolicy: TradingPolicyConfig;
  /** Startup values of the runtime keys of the quoting. */
  quoting: QuotingSettings;
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;
/** The largest wait between two attempts of a read (exponential backoff with jitter). */
export const TRADING_RETRY_MAX_DELAY_MS = 2000;
/** RECHECK_INTERVAL_MS bounds: the plan's 30-60 s sit well inside; below 5 s the check would only load trading. */
export const MIN_RECHECK_INTERVAL_MS = 5000;
export const MAX_RECHECK_INTERVAL_MS = 600_000;

/** The keys RUNTIME_CONFIG_FILE may set; any other key in the file is reported and ignored. */
export const RUNTIME_KEYS = ["LOG_LEVEL", "QUOTING_ENABLED", "SPREAD_MICRO", "LEVELS", "RECHECK_INTERVAL_MS"] as const;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Source = Readonly<Record<string, string | undefined>>;

/** Readers of one source of settings; each records its problems instead of throwing, so all of them are reported. */
function readerOf(source: Source, problems: string[], empty: ReadonlySet<string> = new Set()) {
  const text = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  // `fallback` is the value of a key that is not set; `onInvalid` (default: the same) the value of a key that is set but
  // fails its check, which the runtime file sets to the value in force. A key in `empty` is set with nothing after the
  // `=` (the runtime file reports it): it counts as invalid, not as missing, so clearing a value never undoes an override.
  const unset = <T>(name: string, fallback: T, onInvalid: T): T => (empty.has(name) ? onInvalid : fallback);
  const integer = (name: string, fallback: number, min: number, max: number, onInvalid: number = fallback): number => {
    const raw = text(name);
    if (raw === undefined) return unset(name, fallback, onInvalid);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return onInvalid;
    }
    return value;
  };
  const boolean = (name: string, fallback: boolean, onInvalid: boolean = fallback): boolean => {
    const raw = text(name);
    if (raw === undefined) return unset(name, fallback, onInvalid);
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`${name} must be true or false`);
    return onInvalid;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T, onInvalid: T = fallback): T => {
    const raw = text(name);
    if (raw === undefined) return unset(name, fallback, onInvalid);
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(", ")}`);
    return onInvalid;
  };
  /** An http(s) or nats URL without a user name or password (the secret comes from its own key). */
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      const parsed = new URL(value);
      if (protocols.includes(parsed.protocol) && parsed.username === "" && parsed.password === "") return value.replace(/\/+$/, "");
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")}, without a user name or password`);
    return null;
  };
  /**
   * The runtime keys, read on top of `base` (a key that is not set). A key that is set but invalid takes its value from
   * `inForce` (default `base`), so a typo in the runtime file never undoes an override that is running. The kill switch
   * QUOTING_ENABLED fails closed instead: an invalid or empty value switches quoting off, whatever is in force, so
   * QUOTING_ENABLED=flase stops a bot that was running and a restart with the same file does not start it quoting.
   */
  const runtime = (base: RuntimeSettings, inForce: RuntimeSettings = base): RuntimeSettings => ({
    logLevel: choice("LOG_LEVEL", LOG_LEVELS, base.logLevel, inForce.logLevel),
    quoting: {
      enabled: boolean("QUOTING_ENABLED", base.quoting.enabled, false),
      spreadMicro: integer("SPREAD_MICRO", base.quoting.spreadMicro, SPREAD_MICRO_MIN, SPREAD_MICRO_MAX, inForce.quoting.spreadMicro),
      levels: integer("LEVELS", base.quoting.levels, 1, LEVELS_MAX, inForce.quoting.levels),
      recheckIntervalMs: integer("RECHECK_INTERVAL_MS", base.quoting.recheckIntervalMs, MIN_RECHECK_INTERVAL_MS, MAX_RECHECK_INTERVAL_MS, inForce.quoting.recheckIntervalMs),
    },
  });
  return { text, integer, boolean, choice, url, runtime };
}

/** The defaults of the runtime keys: spread 0.02 (also its minimum, pricing.ts), three levels per side, a check every 30 s. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  logLevel: "info",
  quoting: { enabled: true, spreadMicro: 20_000, levels: 3, recheckIntervalMs: 30_000 },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const read = readerOf(env, problems);
  const { text, integer, url } = read;

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const runtime = read.runtime(DEFAULT_RUNTIME_SETTINGS);

  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));
  const tradingUrl = url("TRADING_URL", ["http:", "https:"], required("TRADING_URL", "the base URL of trading's internal port, for example http://trading:8081"));

  // The service token for trading: KEYCLOAK_URL, KEYCLOAK_REALM and the client's secret belong together.
  let keycloak: KeycloakConfig | null = null;
  const keycloakUrl = required("KEYCLOAK_URL", "the Keycloak base URL, for the bot's service token");
  if (keycloakUrl !== undefined) {
    const checkedUrl = url("KEYCLOAK_URL", ["http:", "https:"], keycloakUrl);
    const realm = text("KEYCLOAK_REALM");
    const clientId = text("MARKET_MAKER_CLIENT_ID") ?? "market-maker";
    const clientSecret = text("MARKET_MAKER_CLIENT_SECRET");
    if (!realm) problems.push("KEYCLOAK_REALM is required when KEYCLOAK_URL is set");
    if (!clientSecret) problems.push("MARKET_MAKER_CLIENT_SECRET is required when KEYCLOAK_URL is set");
    if (checkedUrl && realm && clientSecret) keycloak = { url: checkedUrl, realm, clientId, clientSecret };
  } else if (isLocal && text("TRADING_URL") !== undefined) {
    problems.push("KEYCLOAK_URL is required when TRADING_URL is set: the calls to trading need a service token");
  }

  const tradingPolicy: TradingPolicyConfig = {
    timeoutMs: integer("TRADING_TIMEOUT_MS", 3000, 100, 60_000),
    retries: integer("TRADING_RETRIES", 2, 0, 10),
    circuitFailures: integer("TRADING_CIRCUIT_FAILURES", 5, 1, 100),
    circuitHalfOpenMs: integer("TRADING_CIRCUIT_HALF_OPEN_MS", 10_000, 1000, 600_000),
  };

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The probes' port never serves /metrics (so nothing that reaches the probes can ever read it): two listeners, two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel: runtime.logLevel,
    runtimeConfigFile: text("RUNTIME_CONFIG_FILE") ?? null,
    runtimeConfigPollMs: integer("RUNTIME_CONFIG_POLL_MS", 10_000, 1000, 3_600_000),
    natsUrl,
    tradingUrl,
    keycloak,
    tradingPolicy,
    quoting: runtime.quoting,
    // Nothing routes requests to the bot (no Service traffic, only probes), so by default it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", 0, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The realm's client-credentials token endpoint. */
export function keycloakTokenUrl(keycloak: KeycloakConfig): string {
  return `${keycloak.url}/realms/${encodeURIComponent(keycloak.realm)}/protocol/openid-connect/token`;
}

/** The startup values of the runtime keys. */
export function runtimeSettingsOf(config: Config): RuntimeSettings {
  return { logLevel: config.logLevel, quoting: { ...config.quoting } };
}

export interface RuntimeFileResult {
  settings: RuntimeSettings;
  /** Invalid or empty values and unknown keys; the service logs them, and an invalid key keeps the value in force. */
  problems: string[];
  /** True when the file's QUOTING_ENABLED is invalid or empty, so quoting is switched off (the kill switch fails closed). */
  quotingFailedClosed: boolean;
}

/** The runtime keys that the environment sets: they win over the runtime file (ADR-037). */
export function runtimeKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return RUNTIME_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Reads the runtime file: lines KEY=value, blank lines and lines starting with # are skipped, the last of repeated
 * keys counts. A key that is not in the file takes its startup value (defaults, then env), so deleting a line undoes
 * an override. A key whose value is invalid, or present with nothing after the `=`, keeps `inForce`, the settings now
 * running (default: the startup values), except QUOTING_ENABLED, the kill switch, which fails closed: an invalid or empty
 * value switches quoting off (`quotingFailedClosed`), also in a fresh process where nothing is in force yet. An unknown
 * or misspelled key is only reported. A key in `setInEnv` keeps its environment value (ADR-037: env wins over the file)
 * and is reported. Never throws: a running service keeps working with what it has.
 */
export function parseRuntimeFile(content: string, startup: RuntimeSettings, setInEnv: readonly string[] = [], inForce: RuntimeSettings = startup): RuntimeFileResult {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  const emptyAt = new Map<string, number>();
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      problems.push(`Line ${index + 1}: ${key || "a line without KEY=value"} is not a runtime key (${RUNTIME_KEYS.join(", ")})`);
      continue;
    }
    const value = line.slice(separator + 1).trim();
    // The last of repeated keys counts, empty or not.
    if (value === "") {
      emptyAt.set(key, index + 1);
      delete values[key];
    } else {
      emptyAt.delete(key);
      values[key] = value;
    }
  }
  for (const key of setInEnv) {
    if (key in values || emptyAt.has(key)) {
      problems.push(`${key} is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored`);
      delete values[key];
      emptyAt.delete(key);
    }
  }
  for (const [key, line] of emptyAt) problems.push(`Line ${line}: ${key} has no value (delete the line to use the startup value)`);
  const settings = readerOf(values, problems, new Set(emptyAt.keys())).runtime(startup, inForce);
  const quotingSwitch = values["QUOTING_ENABLED"];
  const quotingFailedClosed = emptyAt.has("QUOTING_ENABLED") || (quotingSwitch !== undefined && quotingSwitch !== "true" && quotingSwitch !== "false");
  return { settings, problems, quotingFailedClosed };
}
