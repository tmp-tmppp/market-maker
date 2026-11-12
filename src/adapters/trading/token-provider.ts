import type { Clock } from "../../usecases/ports.js";

/** Where the trading client gets the bearer token for trading's internal endpoints. */
export interface AccessTokenSource {
  token(): Promise<string>;
  /** The token was refused by the other side: forget it, so that the next call fetches a new one. */
  invalidate?(): void;
}

/** No service token could be obtained (the identity provider is down, slow or refused the client). Never carries the secret. */
export class TokenUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenUnavailable";
  }
}

export interface ClientCredentialsOptions {
  /** The realm's token endpoint (`keycloakTokenUrl(config.keycloak)`). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Per request. Default 3000. */
  timeoutMs?: number;
  /** A cached token is replaced this long before it expires. Default 30000. */
  refreshBeforeExpiryMs?: number;
  /** Replaced in tests. */
  clock?: Clock;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30_000;
/** Keycloak always sends expires_in; this only covers a response without it. */
const DEFAULT_LIFETIME_SECONDS = 60;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * OAuth 2.0 client-credentials grant against the identity provider (client `market-maker`, a service account): the
 * access token trading expects from the bot on its internal port (plan 6.4, ADR-041). The token is cached until shortly
 * before it expires, and while one request for a token is running every caller waits for that one (single flight), so
 * a burst of quote runs costs one request. Any failure is a TokenUnavailable and is never cached; its message names the status or the kind of failure,
 * never the secret or the token.
 */
export class ClientCredentialsTokenProvider implements AccessTokenSource {
  private readonly http: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly refreshBeforeExpiryMs: number;
  private cached: { value: string; validUntilMs: number } | null = null;
  private inFlight: Promise<string> | null = null;
  /** Bumped by invalidate(): a request that was already running must not store its token afterwards. */
  private generation = 0;

  constructor(private readonly options: ClientCredentialsOptions) {
    this.http = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => new Date() };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshBeforeExpiryMs = options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
  }

  token(): Promise<string> {
    if (this.cached && this.clock.now().getTime() < this.cached.validUntilMs) return Promise.resolve(this.cached.value);
    this.inFlight ??= this.request().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = null;
    this.generation += 1;
  }

  private async request(): Promise<string> {
    const generation = this.generation;
    let response: Response;
    try {
      response = await this.http(this.options.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }).toString(),
        // A redirect would send the client secret on to another address.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TokenUnavailable(timedOut ? "The token endpoint did not answer in time" : "The token endpoint cannot be reached", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TokenUnavailable(`The token endpoint answered ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new TokenUnavailable("The token response is not JSON", { cause: error });
    }
    if (!isRecord(body) || typeof body["access_token"] !== "string" || body["access_token"].length === 0) {
      throw new TokenUnavailable("The token response has no access_token");
    }
    const type = body["token_type"];
    if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) {
      throw new TokenUnavailable("The token response is not a bearer token");
    }
    const lifetime = body["expires_in"] ?? DEFAULT_LIFETIME_SECONDS;
    if (typeof lifetime !== "number" || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new TokenUnavailable("The token response has no usable expires_in");
    }

    const value = body["access_token"];
    // A token that lives no longer than the margin is used once and not kept.
    const keptForMs = Math.max(0, lifetime * 1000 - this.refreshBeforeExpiryMs);
    if (generation === this.generation && keptForMs > 0) {
      this.cached = { value, validUntilMs: this.clock.now().getTime() + keptForMs };
    }
    return value;
  }
}
