import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export type WagerTransactionOrigin = 'SUBMISSION' | 'RECHECK';

/** Recebe os desfechos de transações já confirmados no banco, para log e métricas. */
export abstract class WageringMonitor {
  /** Novo estado gravado: aplicada, rejeitada, falha ou (de novo) aguardando a referência. */
  abstract recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void;

  /** Submissão repetida respondida com o resultado já gravado. */
  abstract replayed(transaction: WagerTransaction): void;
}
