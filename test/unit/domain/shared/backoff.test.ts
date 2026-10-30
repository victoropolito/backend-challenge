import { describe, expect, it } from 'bun:test';
import { exponentialBackoffDelayMs } from '../../../../src/domain/shared/backoff';

const policy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

describe('exponentialBackoffDelayMs', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [6, 32_000],
    [7, 60_000],
    [1_000, 60_000],
  ])('attempt %p → %p ms', (attempt, expected) => {
    expect(exponentialBackoffDelayMs(attempt, policy)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects attempt %p', (attempt) => {
    expect(() => exponentialBackoffDelayMs(attempt, policy)).toThrow(RangeError);
  });
});
