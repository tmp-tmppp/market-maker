// The failures a use case passes on. Both are thrown by the TradingClient adapter and are never caught silently: the
// event consumer naks the message (a later delivery repeats the quote run). The periodic check counts a failure of one
// market and goes on with the next; it ends its run only when the list call fails or every call would fail now
// (TradingUnavailable with scope "service"). Their messages never hold a token, a secret or a response body.

/**
 * How far a TradingUnavailable reaches. "service": every call fails now (the circuit is open, no service token, 401,
 * 403), so a periodic check ends its run. "call": this call failed (network, timeout, 408, 429, 5xx after the retries)
 * and the next market may still succeed. The default is "call", so a forgotten scope never stops a check early.
 */
export type UnavailableScope = "service" | "call";

export interface TradingUnavailableOptions extends ErrorOptions {
  scope?: UnavailableScope;
  /**
   * false: no request of this call reached trading (the circuit was already open, or there was no service token), so the
   * market this call was for has not been tried. Left out when a request was sent or the adapter does not know.
   */
  sent?: boolean;
}

/** trading cannot answer now: unreachable, slow, 408, 429, 5xx, the circuit is open, no service token, or 401/403. */
export class TradingUnavailable extends Error {
  readonly code = "trading_unavailable";
  readonly scope: UnavailableScope;
  /** false when no request of the call reached trading (see the option); undefined when one was sent or it is not known. */
  readonly sent: boolean | undefined;

  constructor(message: string, options?: TradingUnavailableOptions) {
    super(message, options);
    this.name = "TradingUnavailable";
    this.scope = options?.scope ?? "call";
    this.sent = options?.sent;
  }
}

/** trading answered outside its contract (an unexpected status or a body that fails the schema): a defect to report. */
export class TradingContractViolation extends Error {
  readonly code = "trading_contract_violation";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TradingContractViolation";
  }
}
