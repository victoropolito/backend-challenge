import type { EntityManager } from '@mikro-orm/postgresql';
import { TransactionRunner } from '../../application/shared/transaction-runner';

/** TransactionRunner sobre `em.transactional()`: commit ao fim de `work`, rollback se ela lançar. */
export class MikroOrmTransactionRunner extends TransactionRunner {
  constructor(private readonly em: EntityManager) {
    super();
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work());
  }
}
