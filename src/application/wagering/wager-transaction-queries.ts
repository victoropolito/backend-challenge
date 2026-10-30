import { DomainError } from '../../domain/shared/domain-error';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import { isUuid } from '../shared/uuid';

export class WagerTransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Consultas de transações por id interno ou por (providerId, externalTransactionId). */
export class WagerTransactionQueries {
  constructor(private readonly wagerTransactions: WagerTransactionRepository) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const transaction = isUuid(transactionId) ? await this.wagerTransactions.findById(transactionId) : undefined;
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError(`Transaction ${transactionId} does not exist`);
    }
    return transaction;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.wagerTransactions.findByExternalId(providerId, externalTransactionId);
    if (transaction === undefined) {
      throw new WagerTransactionNotFoundError(
        `Transaction ${externalTransactionId} of provider ${providerId} does not exist`,
      );
    }
    return transaction;
  }
}
