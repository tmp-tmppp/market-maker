/** Stable codes of the domain's refusals; the use cases log them and never expose them to anyone else. */
export type DomainErrorCode = "invalid_input" | "invariant_violated";

/**
 * A rule of the domain refused its input. The pricing functions throw it only for input that the contract with trading
 * never produces (a negative holding, a price off the grid), so seeing one in a log is a defect to fix, not a state of
 * the market.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
