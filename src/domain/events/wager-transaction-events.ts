import type { FailureCode } from '../wagering/failure-code';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../wagering/wager-transaction';
import type { MoneyProps } from '../shared/money';
import { IntegrationEvent, InvalidIntegrationEventError, type EventContext } from './integration-event';

interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  referenceTransactionId: string | null;
  failureCode: FailureCode;
  balance: MoneyProps | null;
}

export interface WagerTransactionFailedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  referenceCheckAttempts: number;
  nextReferenceCheckAt: string;
}

/** Emitido quando uma transação é aplicada (inclusive LOSS), com o saldo observado após a aplicação. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(ctx: EventContext, data: WagerTransactionProcessedData) {
    super({ ...ctx, aggregateId: data.transactionId, data });
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed(ctx, {
      ...baseData(transaction),
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      balance: transaction.observedBalance!.toJSON(),
      processedAt: transaction.processedAt!.toISOString(),
    });
  }
}

/** Emitido quando uma transação é rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(ctx: EventContext, data: WagerTransactionRejectedData) {
    super({ ...ctx, aggregateId: data.transactionId, data });
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected(ctx, {
      ...baseData(transaction),
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode!,
      balance: transaction.observedBalance?.toJSON() ?? null,
    });
  }
}

/** Emitido quando a transação referenciada ainda não existe e o processamento foi adiado. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(ctx: EventContext, data: WagerTransactionPendingReferenceData) {
    super({ ...ctx, aggregateId: data.transactionId, data });
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference(ctx, {
      ...baseData(transaction),
      referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
      referenceCheckAttempts: transaction.referenceCheckAttempts,
      nextReferenceCheckAt: transaction.nextReferenceCheckAt!.toISOString(),
    });
  }
}

/** Emitido quando uma transação já gravada termina sem ser aplicada por um erro que se repetiu até o limite de tentativas. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  private constructor(ctx: EventContext, data: WagerTransactionFailedData) {
    super({ ...ctx, aggregateId: data.transactionId, data });
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    assertStatus(transaction, WagerTransactionStatus.Failed);
    return new WagerTransactionFailed(ctx, { ...baseData(transaction), failureCode: transaction.failureCode! });
  }
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvalidIntegrationEventError(
      `Transaction ${transaction.id} is ${transaction.status}, expected ${expected}`,
    );
  }
}

function baseData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  };
}
