import { readFileSync } from "node:fs";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createMetrics, startMetricsServer } from "../../src/adapters/metrics/metrics.js";
import type { Metrics, MetricsServer } from "../../src/adapters/metrics/metrics.js";
import { createQuoteMetrics } from "../../src/adapters/metrics/quote-metrics.js";
import { buildHealthApp } from "../../src/web/health-app.js";
import type { BrokerState } from "../../src/web/health-app.js";

// The metrics wired the way src/main.ts wires them: the probes' application records every response, the registry is
// served by a listener of its own, and the probes' port never serves /metrics. The convention itself (labels, buckets,
// the listener) is tested in tests/adapters/metrics.test.ts.

const apps: Array<{ close(): Promise<unknown> }> = [];
const servers: MetricsServer[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
});

function setup(options: { broker?: BrokerState; draining?: boolean } = {}) {
  // The market maker has no authentication: no request names a tenant (src/main.ts passes () => null).
  const metrics: Metrics = createMetrics({ tenantOf: () => null });
  createQuoteMetrics(metrics.registry);
  const app = buildHealthApp({
    logger: pino({ level: "silent" }),
    metrics,
    checks: { brokerState: () => options.broker ?? "connected", isDraining: () => options.draining ?? false },
  });
  apps.push(app);
  return { metrics, app };
}

async function counter(metrics: Metrics, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

async function serve(metrics: Metrics): Promise<(path: string) => string> {
  const server = await startMetricsServer(metrics.registry, { port: 0, host: "127.0.0.1" });
  servers.push(server);
  return (path) => `http://127.0.0.1:${server.port}${path}`;
}

describe("the metrics of the probes' application", () => {
  it("counts each probe under its own route, with the agreed labels and the tenant none", async () => {
    const { metrics, app } = setup();
    for (const path of ["/health/startup", "/health/ready", "/health/live"]) expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200);
    for (const route of ["/health/startup", "/health/ready", "/health/live"]) {
      expect(await counter(metrics, { method: "GET", route, status_code: "200", tenant: "none" })).toBe(1);
    }
  });

  it("counts the 503 of readiness while the bot drains", async () => {
    const { metrics, app } = setup({ draining: true });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
    expect(await counter(metrics, { method: "GET", route: "/health/ready", status_code: "503", tenant: "none" })).toBe(1);
  });

  it('counts a request for any other path as 404 on the route "unmatched", never with the URL as a label', async () => {
    const { metrics, app } = setup();
    expect((await app.inject({ method: "GET", url: "/v1/markets/018f3c1e-7a00-7000-8000-000000000101?secret=1" })).statusCode).toBe(404);
    expect(await counter(metrics, { method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toMatch(/018f3c1e|secret=1/);
  });

  it("does not serve /metrics on the probes' port: it is a 404 counted as unmatched, and the body holds no metric", async () => {
    const { metrics, app } = setup();
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(response.body).not.toContain("# TYPE");
    expect(await counter(metrics, { method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });

  it('gives a request with a token, or with a tenant header, the tenant "none": the bot takes no tenant from a request', async () => {
    const { metrics, app } = setup();
    await app.inject({ method: "GET", url: "/health/live", headers: { authorization: "Bearer abc.def.ghi", "x-tenant-id": "acme", "x-tenant": "acme" } });
    await app.inject({ method: "GET", url: "/health/live" });
    expect(await counter(metrics, { route: "/health/live", tenant: "none" })).toBe(2);
    expect(await counter(metrics, { tenant: "acme" })).toBe(0);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const app = buildHealthApp({ logger: pino({ level: "silent" }), checks: { brokerState: () => "connected", isDraining: () => false } });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });
});

describe("the metrics server of the market maker", () => {
  it("answers GET /metrics, and its counters move with a request to the probes", async () => {
    const { metrics, app } = setup();
    const url = await serve(metrics);

    const before = await (await fetch(url("/metrics"))).text();
    expect(before).toContain("# TYPE http_requests_total counter");
    expect(before).not.toContain('http_requests_total{method="GET",route="/health/live"');

    await app.inject({ method: "GET", url: "/health/live" });
    const once = await (await fetch(url("/metrics"))).text();
    expect(once).toContain('http_requests_total{method="GET",route="/health/live",status_code="200",tenant="none"} 1');
    expect(once).toContain('http_request_duration_seconds_count{method="GET",route="/health/live",status_code="200",tenant="none"} 1');

    await app.inject({ method: "GET", url: "/health/live" });
    const twice = await (await fetch(url("/metrics"))).text();
    expect(twice).toContain('http_requests_total{method="GET",route="/health/live",status_code="200",tenant="none"} 2');
  });

  it("serves the process metrics and the quote-run counters of the same registry", async () => {
    const { metrics } = setup();
    const url = await serve(metrics);
    const body = await (await fetch(url("/metrics"))).text();
    expect(body).toContain("process_cpu_user_seconds_total");
    expect(body).toContain('market_maker_quote_runs_total{outcome="quoted"} 0');
    expect(body).toContain("market_maker_refused_puts_total 0");
  });

  it("answers 404 for every other path, the health probes included", async () => {
    const { metrics } = setup();
    const url = await serve(metrics);
    for (const path of ["/health/live", "/health/ready", "/"]) expect((await fetch(url(path))).status, path).toBe(404);
  });
});

describe("the metrics wiring of src/main.ts", () => {
  // src/main.ts is the composition root and is excluded from coverage, so no other test runs it.
  const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

  it("gives every request the tenant none, and hands the metrics to the probes' application and the quote counters to QuoteMarket", () => {
    expect(main).toContain("createMetrics({ tenantOf: () => null })");
    expect(main).toMatch(/buildHealthApp\(\{\s+logger,\s+metrics,/);
    expect(main).toContain("observer: quoteMetrics");
  });

  it("serves the metrics on their own port, before the probes' port, and closes that listener after the health server on shutdown", () => {
    expect(main).toContain("startMetricsServer(metrics.registry, { port: config.metricsPort })");
    expect(main.indexOf("startMetricsServer(")).toBeLessThan(main.indexOf("app.listen("));
    expect(main).toMatch(/await app\.close\(\);\s+await metricsServer\.close\(\);/);
  });
});
