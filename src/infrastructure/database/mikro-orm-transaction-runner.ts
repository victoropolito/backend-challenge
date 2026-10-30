import type { EntityManager } from '@mikro-orm/postgresql';
import { TransactionRunner } from '../../application/shared/transaction-runner';
import { lockConflictReason, type LockConflictReason } from './transient-error';

/**
 * TransactionRunner sobre `em.transactional()`: commit ao fim de `work`, rollback se ela lançar. `onLockConflict`
 * recebe o motivo de cada transação desfeita por conflito de lock ou de concorrência.
 */
export class MikroOrmTransactionRunner extends TransactionRunner {
  constructor(
    private readonly em: EntityManager,
    private readonly onLockConflict?: (reason: LockConflictReason) => void,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(() => work());
    } catch (error) {
      const reason = lockConflictReason(error);
      if (reason !== undefined) {
        this.onLockConflict?.(reason);
      }
      throw error;
    }
  }
}
