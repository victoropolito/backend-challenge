import type { EventContext } from '../../domain/events/integration-event';
import type { Money } from '../../domain/shared/money';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { OutboxRepository } from '../../domain/messaging/messaging-repositories';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wagering/wager-transaction';
import type { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { LedgerRepository, WalletRepository } from '../../domain/wallet/wallet-repository';
import type { IdGenerator } from '../shared/id-generator';

export interface MissingReference {
  /** A referência, quando já existe mas ainda aguarda a própria referência. */
  reference: WagerTransaction | undefined;
  observedBalance: Money;
}

export interface EventOrigin {
  now: Date;
  correlationId: string;
  causationId?: string | undefined;
}

export interface ProcessingContext extends EventOrigin {
  /** Chamado quando a referência ainda não existe ou ainda aguarda a própria referência; deve levar a transação a PENDING_REFERENCE ou REJECTED. */
  onMissingReference(transaction: WagerTransaction, missing: MissingReference): void;
}

export interface WagerTransactionProcessorDependencies {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  wagerTransactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  ids: IdGenerator;
}

/**
 * Decide o desfecho de uma transação PENDING (nova, ainda não gravada) ou PENDING_REFERENCE (já gravada) e grava
 * transação, lançamento, saldo e eventos. Quando a transação termina, antecipa a verificação das que esperam por ela.
 * Precisa rodar dentro de uma transação SQL com a wallet travada.
 */
export class WagerTransactionProcessor {
  constructor(private readonly deps: WagerTransactionProcessorDependencies) {}

  async process(transaction: WagerTransaction, wallet: Wallet | undefined, context: ProcessingContext): Promise<void> {
    const previousStatus = transaction.status;
    const expectedVersion = wallet?.version;

    const entry = await this.decide(transaction, wallet, context);
    if (transaction.status === WagerTransactionStatus.Pending) {
      throw new Error(`Transaction ${transaction.id} was left PENDING by onMissingReference`);
    }

    if (previousStatus === WagerTransactionStatus.Pending) {
      await this.deps.wagerTransactions.insert(transaction);
    } else {
      await this.deps.wagerTransactions.update(transaction);
    }
    if (entry !== undefined) {
      await this.deps.ledger.insert(entry);
      await this.deps.wallets.update(wallet!, expectedVersion!);
    }
    await this.afterOutcome(transaction, previousStatus, wallet, entry, context);
  }

  /** Leva uma transação PENDING_REFERENCE já gravada a FAILED com PROCESSING_ERROR. Mesmas exigências de `process`. */
  async fail(transaction: WagerTransaction, origin: EventOrigin): Promise<void> {
    const previousStatus = transaction.status;
    transaction.fail(FailureCode.ProcessingError);
    await this.deps.wagerTransactions.update(transaction);
    await this.afterOutcome(transaction, previousStatus, undefined, undefined, origin);
  }

  private async afterOutcome(
    transaction: WagerTransaction,
    previousStatus: WagerTransactionStatus,
    wallet: Wallet | undefined,
    entry: WalletLedgerEntry | undefined,
    origin: EventOrigin,
  ): Promise<void> {
    await this.enqueueEvents(transaction, previousStatus, wallet, entry, origin);
    if (transaction.isTerminal()) {
      await this.deps.wagerTransactions.scheduleReferenceChecksFor(transaction, origin.now);
    }
  }

  /** Aplica as regras de negócio na ordem: wallet, referência, reversão única, saldo. Retorna o lançamento, se houver. */
  private async decide(
    transaction: WagerTransaction,
    wallet: Wallet | undefined,
    context: ProcessingContext,
  ): Promise<WalletLedgerEntry | undefined> {
    if (wallet === undefined) {
      transaction.reject(FailureCode.WalletNotFound);
      return undefined;
    }
    if (wallet.playerId !== transaction.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch);
      return undefined;
    }
    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch);
      return undefined;
    }

    const observedBalance = wallet.balance;
    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await this.deps.wagerTransactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (reference === undefined) {
        context.onMissingReference(transaction, { reference: undefined, observedBalance });
        return undefined;
      }
      const failure = transaction.checkReference(reference);
      if (failure === FailureCode.ReferenceNotProcessed && reference.status === WagerTransactionStatus.PendingReference) {
        context.onMissingReference(transaction, { reference, observedBalance });
        return undefined;
      }
      if (failure !== undefined) {
        transaction.reject(failure, { referenceTransactionId: reference.id, observedBalance });
        return undefined;
      }
      if (transaction.requiresReference() && (await this.deps.wagerTransactions.hasProcessedReversal(reference.id))) {
        transaction.reject(FailureCode.ReferenceAlreadyReversed, { referenceTransactionId: reference.id, observedBalance });
        return undefined;
      }
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, observedBalance, context.now);
      return undefined;
    }

    const movement = { entryId: this.deps.ids.next(), transactionId: transaction.id, money: transaction.money, at: context.now };
    let entry: WalletLedgerEntry;
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
      if (!wallet.canDebit(transaction.money)) {
        const code =
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientBalance
            : FailureCode.ReversalInsufficientBalance;
        transaction.reject(code, { referenceTransactionId: reference?.id, observedBalance });
        return undefined;
      }
      entry = wallet.debit(movement);
    } else {
      entry = wallet.credit(movement);
    }
    transaction.markProcessed(reference?.id, wallet.balance, context.now);
    return entry;
  }

  private async enqueueEvents(
    transaction: WagerTransaction,
    previousStatus: WagerTransactionStatus,
    wallet: Wallet | undefined,
    entry: WalletLedgerEntry | undefined,
    origin: EventOrigin,
  ): Promise<void> {
    const eventContext = (): EventContext => ({
      eventId: this.deps.ids.next(),
      correlationId: origin.correlationId,
      causationId: origin.causationId,
      occurredAt: origin.now,
    });
    const enqueue = (event: Parameters<typeof OutboxMessage.enqueue>[0]) =>
      this.deps.outbox.insert(OutboxMessage.enqueue(event));

    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        await enqueue(WagerTransactionProcessed.from(transaction, eventContext()));
        if (entry !== undefined) {
          await enqueue(WalletBalanceChanged.from(wallet!, entry, eventContext()));
        }
        return;
      case WagerTransactionStatus.Rejected:
        await enqueue(WagerTransactionRejected.from(transaction, eventContext()));
        return;
      case WagerTransactionStatus.Failed:
        await enqueue(WagerTransactionFailed.from(transaction, eventContext()));
        return;
      case WagerTransactionStatus.PendingReference:
        if (previousStatus !== WagerTransactionStatus.PendingReference) {
          await enqueue(WagerTransactionPendingReference.from(transaction, eventContext()));
        }
        return;
      default:
        return;
    }
  }
}
