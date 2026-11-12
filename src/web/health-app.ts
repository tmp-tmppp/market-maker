import { STATUS_CODES } from "node:http";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger as PinoLogger } from "pino";

// The only HTTP surface of the market maker: the three Kubernetes probes (plan REL-05). The bot has no public API and
// is not routed by the gateway, so there is no authentication and no other route; every other path is a 404 problem.
// (GET /metrics is a second surface on a port of its own, see src/adapters/metrics/metrics.ts; this app never serves it.)

/** The broker connection as the readiness probe reports it: reported, never a reason to refuse traffic (see below). */
export type BrokerState = "connected" | "disconnected" | "not_configured";

export interface HealthChecks {
  /** `connected` when every consumer is connected and consuming, `not_configured` in local mode without NATS. */
  brokerState(): BrokerState;
  /** True from the moment the process got SIGTERM: readiness then answers 503 while the work in hand finishes. */
  isDraining(): boolean;
}

export interface HealthAppDeps {
  logger: PinoLogger;
  checks: HealthChecks;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: `urn:chance:problem:${code.replaceAll("_", "-")}`,
      title: STATUS_CODES[status] ?? "Error",
      status,
      detail,
      instance: request.url.split("?")[0] ?? request.url,
      code,
    });
}

/**
 * Builds the Fastify application (not started): the process starts it, the tests call it with app.inject.
 *
 * - `/health/startup`: up once the server listens.
 * - `/health/ready`: 503 `shutting_down` (problem+json) while the process drains, else 200 `{status: "up", broker}`.
 *   The broker state is information, not a condition: nothing is routed to the bot, the periodic check quotes without
 *   NATS, and a 503 while a stream is missing or the broker restarts would fail the release's smoke test and stall the
 *   rollout of a working release. Trading is not checked either: its outage must not take the bot out.
 * - `/health/live`: up while the process answers; it checks nothing, so no outside outage restarts the pod.
 */
export function buildHealthApp(deps: HealthAppDeps): FastifyInstance {
  const { checks } = deps;
  const logger: FastifyBaseLogger = deps.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance: logger,
    exposeHeadRoutes: false,
    // Errors that Fastify raises before a route matches (a malformed URL) are problem details as well.
    frameworkErrors: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 400;
      sendProblem(request, reply, status, "bad_request", "The request URL is invalid");
      // This answer bypasses the hooks of the application, so the metrics are told here (src/adapters/metrics/metrics.ts).
      request.server.recordFrameworkError?.(request, reply);
    },
  });

  // Before the routes and the not-found handler, so that every response is counted, also the 404 of a path that matches
  // no route. The metrics are served on a listener of their own (src/adapters/metrics/metrics.ts), never by this app.
  deps.metrics?.attach(app);

  // Probes run every few seconds: only their problems are logged.
  const probe = { logLevel: "warn" } as const;

  app.get("/health/startup", probe, () => ({ status: "up" }));

  app.get("/health/ready", probe, (request, reply) => {
    if (checks.isDraining()) return sendProblem(request, reply, 503, "shutting_down", "The service is shutting down");
    let broker: BrokerState;
    try {
      broker = checks.brokerState();
    } catch (error) {
      request.log.warn({ err: error }, "The broker state could not be read");
      broker = "disconnected";
    }
    return { status: "up", broker };
  });

  app.get("/health/live", probe, () => ({ status: "up" }));

  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, 404, "not_found", "No such resource"));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 400 && status < 500) return sendProblem(request, reply, status, "bad_request", "The request is invalid");
    request.log.error({ err: error }, "Unhandled error");
    return sendProblem(request, reply, 500, "internal_error", "The service failed to handle the request");
  });

  return app;
}
