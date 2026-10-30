import { exponentialBackoffDelayMs, type BackoffPolicy } from '../../domain/shared/backoff';
import { DomainError } from '../../domain/shared/domain-error';
import type { Money } from '../../domain/shared/money';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  type WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import {
  DuplicateWagerTransactionError,
  type WagerTransactionRepository,
} from '../../domain/wagering/wager-transaction-repository';
import type { WalletRepository } from '../../domain/wallet/wallet-repository';
import type { Clock } from '../shared/clock';
import type { IdGenerator } from '../shared/id-generator';
import type { TransactionRunner } from '../shared/transaction-runner';
import { DEFAULT_REFERENCE_CHECK_POLICY } from './reference-check-policy';
import { wagerPayloadHash } from './wager-payload-hash';
import type { WagerTransactionProcessor } from './wager-transaction-processor';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  causationId?: string | undefined;
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransaction;
  /** true quando a mesma submissão já tinha sido recebida; `transaction` é então o resultado gravado. */
  idempotentReplay: boolean;
}

export interface SubmitWagerTransactionDependencies {
  transactions: TransactionRunner;
  wallets: WalletRepository;
  wagerTransactions: WagerTransactionRepository;
  processor: WagerTransactionProcessor;
  clock: Clock;
  ids: IdGenerator;
  referenceCheckPolicy?: BackoffPolicy;
}

/** A idempotency key já foi usada pelo provider com outro payload. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(`Idempotency key ${idempotencyKey} of ${providerId} was already used with a different payload`);
  }
}

/** O externalTransactionId já foi usado pelo provider com outra idempotency key. */
export class ExternalTransactionIdConflictError extends DomainError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly existingTransactionId: string,
  ) {
    super(`External transaction ${externalTransactionId} of ${providerId} was already submitted with another idempotency key`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recebe uma transação de provider: idempotente por (providerId, idempotencyKey), serializada por wallet com lock
 * pessimista, e atômica (transação, lançamento, saldo e eventos na mesma transação SQL).
 */
export class SubmitWagerTransactionUseCase {
  constructor(private readonly deps: SubmitWagerTransactionDependencies) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const { transactions, wallets, processor, clock, ids } = this.deps;
    const now = clock.now();

    if (!UUID.test(command.walletId)) {
      throw new InvalidWagerTransactionError('walletId must be a UUID');
    }
    const payloadHash = wagerPayloadHash(command);
    const transaction = WagerTransaction.create({
      id: ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const replay = await this.findPrevious(transaction);
    if (replay !== undefined) {
      return replay;
    }

    try {
      return await transactions.run(async () => {
        const wallet = await wallets.findByIdForUpdate(command.walletId);
        const concurrent = await this.findPrevious(transaction);
        if (concurrent !== undefined) {
          return concurrent;
        }
        await processor.process(transaction, wallet, {
          now,
          correlationId: command.correlationId,
          causationId: command.causationId,
          onMissingReference: (pending) => pending.markPendingReference(this.nextReferenceCheck(pending, now)),
        });
        return { transaction, idempotentReplay: false };
      });
    } catch (error) {
      if (error instanceof DuplicateWagerTransactionError && error.conflict !== 'REVERSAL') {
        const raced = await this.findPrevious(transaction);
        if (raced !== undefined) {
          return raced;
        }
      }
      throw error;
    }
  }

  /** Submissão anterior com a mesma idempotency key (replay ou conflito) ou com o mesmo externalTransactionId (conflito). */
  private async findPrevious(transaction: WagerTransaction): Promise<SubmitWagerTransactionResult | undefined> {
    const { wagerTransactions } = this.deps;
    const sameKey = await wagerTransactions.findByIdempotencyKey(transaction.providerId, transaction.idempotencyKey);
    if (sameKey !== undefined) {
      if (!sameKey.matchesPayload(transaction.payloadHash)) {
        throw new IdempotencyConflictError(transaction.providerId, transaction.idempotencyKey, sameKey.id);
      }
      return { transaction: sameKey, idempotentReplay: true };
    }
    const sameExternalId = await wagerTransactions.findByExternalId(transaction.providerId, transaction.externalTransactionId);
    if (sameExternalId !== undefined) {
      throw new ExternalTransactionIdConflictError(transaction.providerId, transaction.externalTransactionId, sameExternalId.id);
    }
    return undefined;
  }

  private nextReferenceCheck(transaction: WagerTransaction, now: Date): Date {
    const policy = this.deps.referenceCheckPolicy ?? DEFAULT_REFERENCE_CHECK_POLICY;
    return new Date(now.getTime() + exponentialBackoffDelayMs(transaction.referenceCheckAttempts + 1, policy));
  }
}
