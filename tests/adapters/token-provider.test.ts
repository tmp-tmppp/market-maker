import { describe, expect, it } from "vitest";
import { ClientCredentialsTokenProvider, TokenUnavailable } from "../../src/adapters/trading/token-provider.js";
import { TestClock } from "../support/fakes.js";

const TOKEN_URL = "http://keycloak.test/realms/chance/protocol/openid-connect/token";
const SECRET = "s3cr3t-value-for-tests";

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  form: URLSearchParams;
  redirect: RequestInit["redirect"];
}

/** A fetch stub: answers from a queue (a Response, or an Error to reject with) and records every call. */
function stub(...answers: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetchStub = (async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      form: new URLSearchParams(init?.body as string),
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

/** `expiresIn` null leaves expires_in out of the answer. */
const tokenResponse = (token: string, expiresIn: number | null = 300, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: token, token_type: "Bearer", ...(expiresIn === null ? {} : { expires_in: expiresIn }), ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function provider(fetchStub: typeof fetch, clock = new TestClock(), extra: Partial<ConstructorParameters<typeof ClientCredentialsTokenProvider>[0]> = {}) {
  return new ClientCredentialsTokenProvider({ tokenUrl: TOKEN_URL, clientId: "market-maker", clientSecret: SECRET, clock, fetch: fetchStub, ...extra });
}

describe("ClientCredentialsTokenProvider", () => {
  it("asks the token endpoint with the client-credentials grant and does not follow redirects", async () => {
    const { fetch, calls } = stub(tokenResponse("token-1"));
    await expect(provider(fetch).token()).resolves.toBe("token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: TOKEN_URL, method: "POST", redirect: "error" });
    expect(calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ grant_type: "client_credentials", client_id: "market-maker", client_secret: SECRET });
  });

  it("keeps the token until shortly before it expires, then fetches a new one", async () => {
    const clock = new TestClock();
    const { fetch, calls } = stub(tokenResponse("token-1", 300), tokenResponse("token-2", 300));
    const tokens = provider(fetch, clock, { refreshBeforeExpiryMs: 30_000 });

    expect(await tokens.token()).toBe("token-1");
    clock.advanceMs(269_000);
    expect(await tokens.token()).toBe("token-1");
    expect(calls).toHaveLength(1);

    clock.advanceMs(1_001); // 270.001 s: inside the 30 s margin before the 300 s lifetime ends
    expect(await tokens.token()).toBe("token-2");
    expect(calls).toHaveLength(2);
  });

  it("makes one request for callers that arrive while it is running", async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetch, calls } = stub(() => pending);
    const tokens = provider(fetch);

    const callers = [tokens.token(), tokens.token(), tokens.token()];
    release(tokenResponse("shared-token"));
    expect(await Promise.all(callers)).toEqual(["shared-token", "shared-token", "shared-token"]);
    expect(calls).toHaveLength(1);
  });

  it("does not keep a token that lives no longer than the margin, and takes the next one from the endpoint", async () => {
    const { fetch, calls } = stub(tokenResponse("short-1", 20), tokenResponse("short-2", 20));
    const tokens = provider(fetch, new TestClock(), { refreshBeforeExpiryMs: 30_000 });
    expect(await tokens.token()).toBe("short-1");
    expect(await tokens.token()).toBe("short-2");
    expect(calls).toHaveLength(2);
  });

  it("treats a response without expires_in as living 60 seconds", async () => {
    const clock = new TestClock();
    const { fetch, calls } = stub(tokenResponse("no-expiry", null), tokenResponse("again", null));
    const tokens = provider(fetch, clock, { refreshBeforeExpiryMs: 10_000 });
    expect(await tokens.token()).toBe("no-expiry");
    clock.advanceMs(49_000);
    expect(await tokens.token()).toBe("no-expiry");
    clock.advanceMs(2_000);
    expect(await tokens.token()).toBe("again");
    expect(calls).toHaveLength(2);
  });

  it("forgets the token on invalidate, and a request that was running then does not store its token", async () => {
    const { fetch, calls } = stub(tokenResponse("token-1"), tokenResponse("token-2"));
    const tokens = provider(fetch);
    expect(await tokens.token()).toBe("token-1");
    tokens.invalidate();
    expect(await tokens.token()).toBe("token-2");
    expect(calls).toHaveLength(2);

    let release: (response: Response) => void = () => undefined;
    const slow = stub(() => new Promise<Response>((resolve) => (release = resolve)), tokenResponse("fresh"));
    const racing = provider(slow.fetch);
    const first = racing.token();
    racing.invalidate();
    release(tokenResponse("stale"));
    expect(await first).toBe("stale"); // the caller that asked gets its answer ...
    expect(await racing.token()).toBe("fresh"); // ... but the stale token was not cached
    expect(slow.calls).toHaveLength(2);
  });

  it.each([
    ["a non-2xx status", () => new Response("{}", { status: 401 }), /answered 401/],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), /not JSON/],
    ["a body without access_token", () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }), /no access_token/],
    ["an empty access_token", () => new Response(JSON.stringify({ access_token: "" }), { status: 200 }), /no access_token/],
    ["a token type that is not bearer", () => tokenResponse("t", 300, { token_type: "mac" }), /not a bearer/],
    ["an expires_in that is not positive", () => tokenResponse("t", 0), /expires_in/],
    ["an expires_in that is not a number", () => tokenResponse("t", "soon" as unknown as number), /expires_in/],
  ])("throws TokenUnavailable for %s, never caches the failure and never names the secret", async (_name, response, message) => {
    const { fetch, calls } = stub(response(), tokenResponse("recovered"));
    const tokens = provider(fetch);
    const failure = await tokens.token().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TokenUnavailable);
    expect((failure as Error).message).toMatch(message);
    expect((failure as Error).message).not.toContain(SECRET);
    expect(await tokens.token()).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("throws TokenUnavailable when the endpoint cannot be reached", async () => {
    const { fetch } = stub(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
    const failure = await provider(fetch).token().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TokenUnavailable);
    expect((failure as Error).message).toBe("The token endpoint cannot be reached");
  });

  it("gives up on an endpoint that does not answer within the timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })) as unknown as typeof fetch;
    const failure = await provider(hang, new TestClock(), { timeoutMs: 40 }).token().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TokenUnavailable);
    expect((failure as Error).message).toBe("The token endpoint did not answer in time");
  });
});
