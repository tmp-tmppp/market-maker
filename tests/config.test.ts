import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_RUNTIME_SETTINGS, keycloakTokenUrl, loadConfig, parseRuntimeFile, runtimeKeysInEnv, runtimeSettingsOf } from "../src/config.js";

const PRODUCTION = {
  NATS_URL: "nats://nats:4222",
  TRADING_URL: "http://trading:8081/",
  KEYCLOAK_URL: "http://keycloak:8080",
  KEYCLOAK_REALM: "chance",
  MARKET_MAKER_CLIENT_SECRET: "test-secret", // hooks:allow test value
};

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("reads a production configuration with its defaults", () => {
    const config = loadConfig(PRODUCTION);
    expect(config).toMatchObject({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      metricsPort: 9464,
      logLevel: "info",
      natsUrl: "nats://nats:4222",
      tradingUrl: "http://trading:8081",
      keycloak: { url: "http://keycloak:8080", realm: "chance", clientId: "market-maker" },
      tradingPolicy: { timeoutMs: 3000, retries: 2, circuitFailures: 5, circuitHalfOpenMs: 10_000 },
      quoting: { enabled: true, spreadMicro: 20_000, levels: 3, recheckIntervalMs: 30_000 },
      shutdownDelayMs: 0,
      runtimeConfigFile: null,
    });
    expect(keycloakTokenUrl(config.keycloak!)).toBe("http://keycloak:8080/realms/chance/protocol/openid-connect/token");
    expect(runtimeSettingsOf(config)).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it("requires NATS, trading and Keycloak outside local mode, and names every problem", () => {
    const problems = problemsOf({});
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining("NATS_URL"), expect.stringContaining("TRADING_URL"), expect.stringContaining("KEYCLOAK_URL")]),
    );
    expect(problemsOf({ ...PRODUCTION, KEYCLOAK_REALM: "", MARKET_MAKER_CLIENT_SECRET: "" })).toHaveLength(2);
  });

  it("runs locally without NATS and trading, but needs Keycloak once TRADING_URL is set", () => {
    const local = loadConfig({ APP_ENV: "local" });
    expect(local).toMatchObject({ isLocal: true, natsUrl: null, tradingUrl: null, keycloak: null });
    expect(problemsOf({ APP_ENV: "local", TRADING_URL: "http://localhost:8091" })).toEqual([expect.stringContaining("KEYCLOAK_URL is required when TRADING_URL")]);
  });

  it("refuses values out of range, wrong URLs and URLs with a login", () => {
    expect(problemsOf({ ...PRODUCTION, SPREAD_MICRO: "200001" })).toEqual([expect.stringContaining("SPREAD_MICRO")]);
    // Below two grid steps level 0 would sell below the curve (pricing.ts, SPREAD_MICRO_MIN).
    expect(problemsOf({ ...PRODUCTION, SPREAD_MICRO: "19999" })).toEqual([expect.stringContaining("SPREAD_MICRO")]);
    expect(problemsOf({ ...PRODUCTION, SPREAD_MICRO: "0" })).toEqual([expect.stringContaining("SPREAD_MICRO")]);
    expect(problemsOf({ ...PRODUCTION, SPREAD_MICRO: "20000" })).toEqual([]);
    expect(problemsOf({ ...PRODUCTION, LEVELS: "11" })).toEqual([expect.stringContaining("LEVELS")]);
    expect(problemsOf({ ...PRODUCTION, LEVELS: "0" })).toEqual([expect.stringContaining("LEVELS")]);
    expect(problemsOf({ ...PRODUCTION, RECHECK_INTERVAL_MS: "4999" })).toEqual([expect.stringContaining("RECHECK_INTERVAL_MS")]);
    expect(problemsOf({ ...PRODUCTION, QUOTING_ENABLED: "yes" })).toEqual([expect.stringContaining("QUOTING_ENABLED")]);
    expect(problemsOf({ ...PRODUCTION, LOG_LEVEL: "loud" })).toEqual([expect.stringContaining("LOG_LEVEL")]);
    expect(problemsOf({ ...PRODUCTION, TRADING_URL: "ftp://trading" })).toEqual([expect.stringContaining("TRADING_URL")]);
    expect(problemsOf({ ...PRODUCTION, TRADING_URL: "http://user:pw@trading:8081" })).toEqual([expect.stringContaining("TRADING_URL")]);
    expect(problemsOf({ ...PRODUCTION, NATS_URL: "http://nats" })).toEqual([expect.stringContaining("NATS_URL")]);
    expect(problemsOf({ ...PRODUCTION, SHUTDOWN_DELAY_MS: "15001" })).toEqual([expect.stringContaining("SHUTDOWN_DELAY_MS")]);
    expect(problemsOf({ ...PRODUCTION, APP_ENV: "Prod" })).toEqual([expect.stringContaining("APP_ENV")]);
  });

  it("never prints the client secret, neither in the error nor in any problem, for several invalid inputs", () => {
    const secret = PRODUCTION.MARKET_MAKER_CLIENT_SECRET;
    const invalid: NodeJS.ProcessEnv[] = [
      { KEYCLOAK_URL: "not a url" },
      { KEYCLOAK_REALM: "" },
      { KEYCLOAK_URL: "http://user:pw@keycloak:8080" },
      { TRADING_URL: "ftp://trading", SPREAD_MICRO: "1", QUOTING_ENABLED: "yes" },
      // The secret's own text where a number is expected: a problem names the key, never the value.
      { SPREAD_MICRO: secret, LEVELS: secret },
    ];
    for (const extra of invalid) {
      let error: unknown;
      try {
        loadConfig({ ...PRODUCTION, ...extra });
      } catch (caught) {
        error = caught;
      }
      const label = JSON.stringify(Object.keys(extra));
      // The configuration must be refused: a test that saw no error would prove nothing about the message.
      expect(error, label).toBeInstanceOf(ConfigError);
      expect(String(error), label).not.toContain(secret);
      expect((error as ConfigError).problems.join("\n"), label).not.toContain(secret);
    }
  });
});

describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
  it("defaults to 9464, also in local mode, and is read from the environment", () => {
    expect(loadConfig(PRODUCTION).metricsPort).toBe(9464);
    expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
    expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "1" }).metricsPort).toBe(1);
    expect(loadConfig({ ...PRODUCTION, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
  });

  it.each(["0", "65536", "-1", "9464.5", "abc"])("refuses METRICS_PORT=%j", (value) => {
    expect(problemsOf({ ...PRODUCTION, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
  });

  it("must differ from PORT: the probes' port never serves /metrics", () => {
    const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
    expect(problemsOf({ ...PRODUCTION, PORT: "9000", METRICS_PORT: "9000" })).toEqual([problem]);
    // The default metrics port is taken by a probes' port of 9464 as well.
    expect(problemsOf({ ...PRODUCTION, PORT: "9464" })).toEqual([problem]);
    expect(loadConfig({ ...PRODUCTION, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
  });
});

describe("parseRuntimeFile", () => {
  const startup = DEFAULT_RUNTIME_SETTINGS;

  it("applies the runtime keys and falls back to the startup value for a missing key", () => {
    const { settings, problems } = parseRuntimeFile("# comment\nQUOTING_ENABLED=false\nSPREAD_MICRO=40000\nLEVELS=5\nRECHECK_INTERVAL_MS=60000\nLOG_LEVEL=debug\n", startup);
    expect(problems).toEqual([]);
    expect(settings).toEqual({ logLevel: "debug", quoting: { enabled: false, spreadMicro: 40_000, levels: 5, recheckIntervalMs: 60_000 } });
    expect(parseRuntimeFile("", startup).settings).toEqual(startup);
  });

  it("keeps the value in force for an invalid or empty key, and only reports an unknown one", () => {
    const inForce = { logLevel: "debug", quoting: { enabled: true, spreadMicro: 40_000, levels: 5, recheckIntervalMs: 60_000 } };
    const invalid = parseRuntimeFile("LOG_LEVEL=loud\nSPREAD_MICRO=1\nLEVELS=\nRECHECK_INTERVAL_MS=\nLEVLES=4", startup, [], inForce);
    expect(invalid.settings).toEqual(inForce);
    expect(invalid.problems).toEqual([
      expect.stringContaining("LEVLES is not a runtime key"),
      expect.stringContaining("LEVELS has no value"),
      expect.stringContaining("RECHECK_INTERVAL_MS has no value"),
      expect.stringContaining("LOG_LEVEL must be one of"),
      expect.stringContaining("SPREAD_MICRO must be an integer"),
    ]);
    expect(invalid.quotingFailedClosed).toBe(false);
  });

  it("fails the kill switch closed: an invalid QUOTING_ENABLED switches quoting off, whatever is in force and also in a fresh process", () => {
    const off = { ...startup, quoting: { ...startup.quoting, enabled: false } };
    for (const inForce of [off, startup]) {
      const { settings, problems, quotingFailedClosed } = parseRuntimeFile("QUOTING_ENABLED=flase\nSPREAD_MICRO=30000", startup, [], inForce);
      expect(settings.quoting).toMatchObject({ enabled: false, spreadMicro: 30_000 });
      expect(problems).toEqual([expect.stringContaining("QUOTING_ENABLED must be true or false")]);
      expect(quotingFailedClosed).toBe(true);
    }
    // No `inForce` at all: what a restarted process has when it reads the file for the first time.
    expect(parseRuntimeFile("QUOTING_ENABLED=flase", startup).settings.quoting.enabled).toBe(false);
  });

  it("treats a key with nothing after the = as invalid, not missing, so clearing QUOTING_ENABLED never quotes again", () => {
    const off = { ...startup, quoting: { ...startup.quoting, enabled: false } };
    for (const content of ["QUOTING_ENABLED=", "QUOTING_ENABLED=   ", "QUOTING_ENABLED=\r\nSPREAD_MICRO=30000"]) {
      const { settings, problems, quotingFailedClosed } = parseRuntimeFile(content, startup, [], off);
      expect(settings.quoting.enabled, content).toBe(false);
      expect(problems, content).toEqual([expect.stringContaining("Line 1: QUOTING_ENABLED has no value")]);
      expect(quotingFailedClosed, content).toBe(true);
    }
    expect(parseRuntimeFile("QUOTING_ENABLED=", startup).settings.quoting.enabled).toBe(false);
    // The last of repeated keys counts, empty or not; a deleted line (a missing key) still falls back to the startup value.
    expect(parseRuntimeFile("QUOTING_ENABLED=\nQUOTING_ENABLED=true", startup, [], off)).toMatchObject({ settings: { quoting: { enabled: true } }, problems: [], quotingFailedClosed: false });
    expect(parseRuntimeFile("QUOTING_ENABLED=true\nQUOTING_ENABLED=", startup)).toMatchObject({ settings: { quoting: { enabled: false } }, quotingFailedClosed: true });
    expect(parseRuntimeFile("SPREAD_MICRO=30000", startup, [], off).settings.quoting.enabled).toBe(true);
    // A key the environment sets keeps its environment value, empty in the file or not.
    expect(parseRuntimeFile("QUOTING_ENABLED=", startup, ["QUOTING_ENABLED"], off)).toMatchObject({
      settings: { quoting: { enabled: true } },
      problems: [expect.stringContaining("QUOTING_ENABLED is set in the environment")],
      quotingFailedClosed: false,
    });
  });

  it("does not flag a valid true or false", () => {
    expect(parseRuntimeFile("QUOTING_ENABLED=true", startup)).toMatchObject({ problems: [], quotingFailedClosed: false });
    expect(parseRuntimeFile("QUOTING_ENABLED=false", startup)).toMatchObject({ settings: { quoting: { enabled: false } }, problems: [], quotingFailedClosed: false });
  });

  it("lets the environment win over the file (ADR-037)", () => {
    const setInEnv = runtimeKeysInEnv({ SPREAD_MICRO: "30000", LEVELS: " " });
    expect(setInEnv).toEqual(["SPREAD_MICRO"]);
    const { settings, problems } = parseRuntimeFile("SPREAD_MICRO=50000\nLEVELS=4", startup, setInEnv);
    expect(settings.quoting.spreadMicro).toBe(startup.quoting.spreadMicro);
    expect(settings.quoting.levels).toBe(4);
    expect(problems).toEqual([expect.stringContaining("SPREAD_MICRO is set in the environment")]);
  });
});
