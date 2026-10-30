import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { ExternalTransactionIdConflictError, IdempotencyConflictError } from './submit-wager-transaction.use-case';

export type WagerTransactionOrigin = 'SUBMISSION' | 'RECHECK';

/** Recebe os desfechos de transações já confirmados no banco, para log e métricas. */
export abstract class WageringMonitor {
  /** Novo estado gravado: aplicada, rejeitada, falha ou (de novo) aguardando a referência. */
  abstract recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void;

  /** Submissão repetida respondida com o resultado já gravado. */
  abstract replayed(transaction: WagerTransaction): void;

  /** Submissão recusada porque a idempotency key ou o externalTransactionId já foram usados de outra forma. */
  abstract conflicted(conflict: IdempotencyConflictError | ExternalTransactionIdConflictError): void;
}
