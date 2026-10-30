import type { EntityManager } from '@mikro-orm/postgresql';
import type { FailureCode } from '../../../domain/wagering/failure-code';
import { Money } from '../../../domain/shared/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction';
import {
  DuplicateWagerTransactionError,
  WagerTransactionRepository,
  type WagerTransactionConflict,
} from '../../../domain/wagering/wager-transaction-repository';
import { WagerTransactionSchema, type WagerTransactionRecord } from '../records/wager-transaction.record';
import { violatedUniqueConstraint } from './constraint-violation';

const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, WagerTransactionConflict>> = {
  wager_transactions_provider_external_key: 'EXTERNAL_TRANSACTION_ID',
  wager_transactions_provider_idempotency_key: 'IDEMPOTENCY_KEY',
  wager_transactions_single_reversal_idx: 'REVERSAL',
};

/** WagerTransactionRepository sobre MikroORM, traduzindo violações de unicidade em DuplicateWagerTransactionError. */
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.translateConflicts(transaction, () => this.em.insert(WagerTransactionSchema, toRecord(transaction)));
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const affected = await this.translateConflicts(transaction, () =>
      this.em.nativeUpdate(
        WagerTransactionSchema,
        { id: transaction.id },
        {
          status: transaction.status,
          referenceTransactionId: transaction.referenceTransactionId ?? null,
          failureCode: transaction.failureCode ?? null,
          processedAt: transaction.processedAt ?? null,
          referenceCheckAttempts: transaction.referenceCheckAttempts,
          nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
          observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
        },
      ),
    );
    if (affected !== 1) {
      throw new Error(`Wager transaction ${transaction.id} does not exist`);
    }
  }

  private async findOne(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, { disableIdentityMap: true });
    return record ? toDomain(record) : undefined;
  }

  private async translateConflicts<T>(transaction: WagerTransaction, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const constraint = violatedUniqueConstraint(error);
      const conflict = constraint === undefined ? undefined : CONFLICT_BY_CONSTRAINT[constraint];
      if (conflict !== undefined) {
        throw new DuplicateWagerTransactionError(conflict, transaction.id);
      }
      throw error;
    }
  }
}

function toDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    referenceCheckAttempts: record.referenceCheckAttempts,
    nextReferenceCheckAt: record.nextReferenceCheckAt ?? undefined,
    observedBalance:
      record.observedBalance === null
        ? undefined
        : Money.rehydrate({ amount: record.observedBalance, currency: record.currency }),
  });
}

function toRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceCheckAttempts: transaction.referenceCheckAttempts,
    nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
    observedBalance: transaction.observedBalance?.toJSON().amount ?? null,
    createdAt: transaction.createdAt,
  };
}
