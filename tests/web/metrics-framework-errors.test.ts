import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { buildHealthApp } from "../../src/web/health-app.js";

// Fastify answers a URL it cannot route (a malformed percent-encoding) through its frameworkErrors handler, on a request
// that carries none of the application's hooks. That answer is still counted, as route "unmatched" and tenant "none".

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function sampleSum(metrics: Metrics, name: string, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name.replace(/_count$/, ""));
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => ((sample as { metricName?: string }).metricName ?? name) === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the answers Fastify gives before a route matches", () => {
  it("counts a malformed URL as a 400 on the route unmatched, for the tenant none, and observes its duration", async () => {
    const metrics = createMetrics({ tenantOf: () => null });
    const app = buildHealthApp({ logger: pino({ level: "silent" }), metrics, checks: { brokerState: () => "connected", isDraining: () => false } });
    apps.push(app);
    const answer = await app.inject({ method: "GET", url: "/health/%E0%A4%A" });
    expect(answer.statusCode).toBe(400);
    const labels = { method: "GET", route: "unmatched", status_code: "400", tenant: "none" };
    expect(await sampleSum(metrics, "http_requests_total", labels)).toBe(1);
    expect(await sampleSum(metrics, "http_request_duration_seconds_count", labels)).toBe(1);
  });
});
