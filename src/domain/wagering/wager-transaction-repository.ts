import { DomainError } from '../shared/domain-error';
import type { WagerTransaction } from './wager-transaction';

export type WagerTransactionConflict = 'EXTERNAL_TRANSACTION_ID' | 'IDEMPOTENCY_KEY' | 'REVERSAL';

export class DuplicateWagerTransactionError extends DomainError {
  readonly code = 'DUPLICATE_WAGER_TRANSACTION';

  constructor(
    readonly conflict: WagerTransactionConflict,
    readonly transactionId: string,
  ) {
    super(`Wager transaction ${transactionId} conflicts with an existing one (${conflict})`);
  }
}

/** Persistência de transações de aposta. */
export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | undefined>;

  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;

  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;

  /** Lança DuplicateWagerTransactionError em conflito de external id, idempotency key ou reversão já processada. */
  abstract insert(transaction: WagerTransaction): Promise<void>;

  /** Grava status, referência resolvida, falha e agendamento; lança DuplicateWagerTransactionError em reversão duplicada. */
  abstract update(transaction: WagerTransaction): Promise<void>;
}
