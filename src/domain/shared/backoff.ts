/** Parâmetros de um backoff exponencial com teto. */
export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Atraso da tentativa `attempt` (1-based): base · 2^(attempt−1), limitado ao teto. */
export function exponentialBackoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const exponent = Math.min(attempt - 1, 52);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}
