import { FakeTradingClient } from "./adapters/fake/fake-trading-client.js";
import { JetStreamConsumer, MARKETS_CONSUMER, TRADING_CONSUMER } from "./adapters/nats/jetstream-consumer.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { createQuoteMetrics } from "./adapters/metrics/quote-metrics.js";
import { handleMarketMessage } from "./adapters/nats/message-handlers.js";
import { RecheckScheduler } from "./adapters/recheck-scheduler.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "./adapters/runtime-config.js";
import { mathRandom, newCorrelationId, systemClock, systemDelay } from "./adapters/system.js";
import { ClientCredentialsTokenProvider } from "./adapters/trading/token-provider.js";
import { TradingHttpClient } from "./adapters/trading/trading-http-client.js";
import { ConfigError, keycloakTokenUrl, loadConfig, runtimeKeysInEnv, runtimeSettingsOf } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";
import { QuoteMarket } from "./usecases/quote-market.js";
import { ReactToMarketEvent } from "./usecases/react-to-market-event.js";
import { RecheckOpenMarkets } from "./usecases/recheck-open-markets.js";
import type { TradingClient } from "./usecases/ports.js";
import { buildHealthApp } from "./web/health-app.js";
import type { BrokerState } from "./web/health-app.js";

// Composition root: configuration -> adapters -> use cases -> the periodic check, the consumers and the health server.
// Nothing else wires things together. The bot is stateless (ADR-041): no database, no inbox, no outbox.

async function main(): Promise<void> {
  // Taken once, before anything consumes or quotes: an event published well before this moment is covered by the
  // start-up check (ReactToMarketEvent skips it).
  const startedAt = systemClock.now();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting market-maker");

  // Runtime settings (ADR-037): the use cases read the quoting settings from the holder at every run; the watcher
  // replaces them, and the log level, when the mounted file changes. A key set in the environment keeps its value, and
  // a key with an invalid or empty value in the file keeps the value in force; QUOTING_ENABLED fails closed instead (an
  // invalid or empty value switches quoting off, also at a restart, so a typo never switches a stopped bot back on).
  const rules = new RuntimeSettingsHolder(runtimeSettingsOf(config));
  const runtimeConfig = config.runtimeConfigFile
    ? new RuntimeConfigWatcher({
        file: config.runtimeConfigFile,
        pollMs: config.runtimeConfigPollMs,
        startup: runtimeSettingsOf(config),
        setInEnv: runtimeKeysInEnv(process.env),
        current: () => rules.get(),
        logger,
        onChange: (settings) => {
          rules.set(settings);
          logger.level = settings.logLevel;
        },
      })
    : null;

  // The trading client: the real one needs trading's URL and a service token; only APP_ENV=local may go without
  // (loadConfig has refused anything else) and then an in-memory trading with one demo market answers.
  let trading: TradingClient;
  if (config.tradingUrl) {
    if (!config.keycloak) throw new Error("TRADING_URL is set without KEYCLOAK_URL: loadConfig should have refused this");
    const tokens = new ClientCredentialsTokenProvider({
      tokenUrl: keycloakTokenUrl(config.keycloak),
      clientId: config.keycloak.clientId,
      clientSecret: config.keycloak.clientSecret,
    });
    trading = new TradingHttpClient({ baseUrl: config.tradingUrl, tokens, policy: config.tradingPolicy, logger });
  } else {
    logger.warn({}, "TRADING_URL is not set: quoting an in-memory demo market through a fake trading client (APP_ENV=local)");
    trading = FakeTradingClient.withDemoMarket(systemClock);
  }

  // Request metrics and the quote-run counters, on one registry. The bot has no authentication, so no request names a
  // tenant: the tenant label of every request is "none".
  const metrics = createMetrics({ tenantOf: () => null });
  const quoteMetrics = createQuoteMetrics(metrics.registry);

  // Use cases. One QuoteMarket (so one serializer) serves the consumers and the periodic check: a notification and a
  // recheck of the same market never run side by side.
  const quote = new QuoteMarket({ trading, settings: rules, clock: systemClock, delay: systemDelay, random: mathRandom, logger, observer: quoteMetrics });
  const react = new ReactToMarketEvent(quote, logger, { startedAt });
  const recheck = new RecheckOpenMarkets({ trading, settings: rules, quote, logger });

  // The two consumers (MARKETS and TRADING); without a broker nothing is consumed and only the periodic check quotes.
  const consumers: JetStreamConsumer[] = [];
  if (config.natsUrl) {
    for (const spec of [MARKETS_CONSUMER, TRADING_CONSUMER]) {
      consumers.push(new JetStreamConsumer({ url: config.natsUrl, spec, handle: (data) => handleMarketMessage(data, react, logger), logger }));
    }
  } else {
    logger.warn({}, "NATS_URL is not set: no events are consumed, only the periodic check quotes (APP_ENV=local)");
  }
  const scheduler = new RecheckScheduler({ recheck, settings: rules, logger, newCorrelationId });

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  const app = buildHealthApp({
    logger,
    metrics,
    checks: {
      // Reported, never a reason for a 503: nothing is routed to the bot and the recheck quotes without the broker.
      brokerState: (): BrokerState => {
        if (consumers.length === 0) return "not_configured";
        return consumers.every((consumer) => consumer.isConnected()) ? "connected" : "disconnected";
      },
      isDraining: () => shuttingDown,
    },
  });

  // Start order: the runtime file first (the first read comes before the first quote, so the startup rules are the
  // file's), then the metrics and health servers, the consumers and last the scheduler, whose start-up check reads every
  // open book. GET /metrics has a listener of its own: the probes' port never serves it.
  await runtimeConfig?.start();
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  await app.listen({ host: "0.0.0.0", port: config.port });
  for (const consumer of consumers) consumer.start();
  scheduler.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      stopConsumers: async () => {
        await Promise.all(consumers.map((consumer) => consumer.stop()));
      },
      stopRecheck: () => scheduler.stop(),
      stopRuntimeConfig: async () => {
        await runtimeConfig?.stop();
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  registerShutdownSignals(shutdown);
}

main().catch((error: unknown) => {
  console.error("market-maker failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
