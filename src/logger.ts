import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

/**
 * JSON logs (ADR-026). The Authorization header, the client secret and the access token are redacted wherever they could
 * appear in a log line; market ids, tenant ids, event ids and correlation ids are bound by the use cases and the
 * consumers. The level can change at runtime (ADR-037).
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "market-maker" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "authorization",
          "*.authorization",
          "clientSecret",
          "*.clientSecret",
          "accessToken",
          "*.accessToken",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
