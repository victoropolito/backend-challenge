import type {
  ExternalTransactionIdConflictError,
  IdempotencyConflictError,
} from '../../application/wagering/submit-wager-transaction.use-case';
import { WageringMonitor, type WagerTransactionOrigin } from '../../application/wagering/wagering-monitor';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { LogFields } from './log-context';
import type { AppLogger } from './structured-logger';

/** WageringMonitor que registra cada desfecho com os identificadores da transação, sem valores nem saldos. */
export class LoggingWageringMonitor extends WageringMonitor {
  constructor(private readonly logger: AppLogger) {
    super();
  }

  recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void {
    const fields = { ...identifiers(transaction), origin, failureCode: transaction.failureCode };
    if (transaction.status === WagerTransactionStatus.Failed) {
      this.logger.error('Wager transaction failed', fields);
    } else if (transaction.status === WagerTransactionStatus.PendingReference && origin === 'RECHECK') {
      this.logger.debug('Wager transaction still waiting for its reference', {
        ...fields,
        referenceCheckAttempts: transaction.referenceCheckAttempts,
      });
    } else {
      this.logger.info('Wager transaction recorded', fields);
    }
  }

  replayed(transaction: WagerTransaction): void {
    this.logger.info('Idempotent replay', identifiers(transaction));
  }

  conflicted(conflict: IdempotencyConflictError | ExternalTransactionIdConflictError): void {
    this.logger.info('Submission conflict', {
      code: conflict.code,
      providerId: conflict.providerId,
      existingTransactionId: conflict.existingTransactionId,
    });
  }
}

function identifiers(transaction: WagerTransaction): LogFields {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    status: transaction.status,
  };
}
