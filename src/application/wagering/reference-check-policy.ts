import type { BackoffPolicy } from '../../domain/shared/backoff';

/** Backoff das verificações de uma transação PENDING_REFERENCE. */
export const DEFAULT_REFERENCE_CHECK_POLICY: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };
