import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHealthApp } from "../../src/web/health-app.js";
import type { BrokerState, HealthChecks } from "../../src/web/health-app.js";

// The probes through app.inject: what each answers, that the broker state is reported and never refused, that nothing
// else is served, and that probes do not fill the log.

class Checks implements HealthChecks {
  broker: BrokerState = "connected";
  draining = false;
  readonly brokerState = vi.fn((): BrokerState => this.broker);
  readonly isDraining = vi.fn((): boolean => this.draining);
}

const open: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

function harness(checks = new Checks()) {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString("utf8")) as Record<string, unknown>);
      done();
    },
  });
  const app = buildHealthApp({ logger: pino({ level: "info" }, destination), checks });
  open.push(app);
  return { app, checks, lines };
}

const get = (app: ReturnType<typeof harness>["app"], url: string) => app.inject({ method: "GET", url });

describe("/health/startup", () => {
  it("is up once the server listens, whatever the broker and the drain say", async () => {
    const { app, checks } = harness();
    checks.broker = "disconnected";
    checks.draining = true;
    const answer = await get(app, "/health/startup");
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: "up" });
    expect(answer.headers["content-type"]).toContain("application/json");
    expect(checks.brokerState).not.toHaveBeenCalled();
  });
});

describe("/health/ready", () => {
  it.each<BrokerState>(["connected", "disconnected", "not_configured"])("answers 200 with the broker state %s: reported, never a reason to refuse", async (broker) => {
    const { app, checks } = harness();
    checks.broker = broker;
    const answer = await get(app, "/health/ready");
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: "up", broker });
  });

  it("reads the broker state at every probe", async () => {
    const { app, checks } = harness();
    checks.broker = "connected";
    expect((await get(app, "/health/ready")).json()).toMatchObject({ broker: "connected" });
    checks.broker = "disconnected";
    expect((await get(app, "/health/ready")).json()).toMatchObject({ broker: "disconnected" });
    checks.broker = "connected";
    expect((await get(app, "/health/ready")).json()).toMatchObject({ broker: "connected" });
  });

  it("answers 503 problem+json shutting_down while the process drains, and 200 again before that", async () => {
    const { app, checks } = harness();
    expect((await get(app, "/health/ready")).statusCode).toBe(200);

    checks.draining = true;
    const answer = await get(app, "/health/ready?probe=kubelet");
    expect(answer.statusCode).toBe(503);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.json()).toEqual({
      type: "urn:chance:problem:shutting-down",
      title: "Service Unavailable",
      status: 503,
      detail: "The service is shutting down",
      instance: "/health/ready",
      code: "shutting_down",
    });
  });

  it("drains first: a draining process says so whatever the broker is, without asking it", async () => {
    const { app, checks } = harness();
    checks.draining = true;
    checks.broker = "disconnected";
    expect((await get(app, "/health/ready")).statusCode).toBe(503);
    expect(checks.brokerState).not.toHaveBeenCalled();
  });

  it("reports the broker as disconnected, and logs it, when its state cannot be read", async () => {
    const { app, checks, lines } = harness();
    checks.brokerState.mockImplementationOnce(() => {
      throw new Error("consumer state unavailable");
    });
    const answer = await get(app, "/health/ready");
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: "up", broker: "disconnected" });
    expect(lines.filter((line) => line["level"] === 40).map((line) => line["msg"])).toEqual(["The broker state could not be read"]);
  });
});

describe("/health/live", () => {
  it("is up while the process answers, and asks nothing: no outage restarts the pod", async () => {
    const { app, checks } = harness();
    checks.broker = "disconnected";
    checks.draining = true;
    const answer = await get(app, "/health/live");
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: "up" });
    expect(checks.brokerState).not.toHaveBeenCalled();
    expect(checks.isDraining).not.toHaveBeenCalled();
  });
});

describe("everything else", () => {
  it.each(["/", "/health", "/health/", "/health/other", "/metrics", "/v1/internal/markets", "/v1/markets", "/health/ready/extra"])("answers 404 problem+json for GET %s", async (url) => {
    const { app } = harness();
    const answer = await get(app, url);
    expect(answer.statusCode).toBe(404);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.json()).toMatchObject({ type: "urn:chance:problem:not-found", title: "Not Found", status: 404, code: "not_found", instance: url.split("?")[0] });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("serves no %s on a probe path", async (method) => {
    const { app } = harness();
    for (const url of ["/health/startup", "/health/ready", "/health/live"]) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
  });

  it("serves no HEAD either: the three probes are GET routes and nothing else", async () => {
    const { app } = harness();
    expect((await app.inject({ method: "HEAD", url: "/health/live" })).statusCode).toBe(404);
  });

  it("answers a malformed URL with a 400 problem, not the framework's own body", async () => {
    const { app } = harness();
    const answer = await get(app, "/health/%zz");
    expect(answer.statusCode).toBe(400);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.json()).toMatchObject({ status: 400, code: "bad_request", detail: "The request URL is invalid" });
  });

  it("answers an unexpected failure with a fixed 500 problem that does not repeat the error, and logs the error", async () => {
    const { app, checks, lines } = harness();
    checks.isDraining.mockImplementationOnce(() => {
      throw new Error("secret detail of the failure");
    });
    const answer = await get(app, "/health/ready");
    expect(answer.statusCode).toBe(500);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.json()).toMatchObject({ status: 500, code: "internal_error", detail: "The service failed to handle the request" });
    expect(answer.body).not.toContain("secret detail");
    expect(lines.some((line) => line["level"] === 50 && line["msg"] === "Unhandled error")).toBe(true);
  });
});

describe("logging", () => {
  it("keeps the probes out of the log (only their problems are logged)", async () => {
    const { app, lines } = harness();
    for (let i = 0; i < 5; i += 1) {
      for (const probe of ["startup", "ready", "live"]) await get(app, `/health/${probe}`);
    }
    expect(lines).toEqual([]);
  });

  it("logs a request to any other path", async () => {
    const { app, lines } = harness();
    await get(app, "/metrics");
    expect(lines.length).toBeGreaterThan(0);
  });
});
