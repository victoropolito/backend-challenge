import { exponentialBackoffDelayMs, type BackoffPolicy } from '../../domain/shared/backoff';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletRepository } from '../../domain/wallet/wallet-repository';
import type { Clock } from '../shared/clock';
import type { IdGenerator } from '../shared/id-generator';
import type { TransactionRunner } from '../shared/transaction-runner';
import { DEFAULT_REFERENCE_CHECK_POLICY } from './reference-check-policy';
import type { EventOrigin, MissingReference, WagerTransactionProcessor } from './wager-transaction-processor';
import type { WageringMonitor } from './wagering-monitor';

export interface RecheckPendingReferencesDependencies {
  transactions: TransactionRunner;
  wallets: WalletRepository;
  wagerTransactions: WagerTransactionRepository;
  processor: Pick<WagerTransactionProcessor, 'process' | 'fail'>;
  clock: Clock;
  ids: IdGenerator;
  /** Número máximo de verificações de uma transação, contando a feita na submissão. */
  maxAttempts: number;
  referenceCheckPolicy?: BackoffPolicy;
  /** Erros que não contam como tentativa: a transação continua vencida e é verificada de novo no próximo lote. */
  isTransientError?: (error: unknown) => boolean;
  monitor?: WageringMonitor;
}

export interface RecheckPendingReferencesResult {
  /** Transações vencidas encontradas no lote. */
  due: number;
  /** Terminadas nesta verificação (PROCESSED, REJECTED ou FAILED). */
  completed: number;
  /** Ainda aguardando a referência, com nova verificação agendada. */
  rescheduled: number;
  /** Já tratadas por outra instância entre a busca e o lock da wallet. */
  skipped: number;
  /** Falhas por transação; as não transitórias contam como tentativa. */
  errors: Map<string, unknown>;
}

type Outcome = 'completed' | 'rescheduled' | 'skipped';

/**
 * Reverifica um lote de transações PENDING_REFERENCE vencidas, cada uma na própria transação SQL com a wallet
 * travada: referência encontrada → aplica ou rejeita pelas regras de sempre; ainda ausente → nova verificação com
 * backoff ou, no limite de tentativas, REJECTED (REFERENCE_NOT_FOUND / REFERENCE_NOT_PROCESSED). Um erro inesperado
 * conta como tentativa; no limite, a transação termina FAILED (PROCESSING_ERROR).
 */
export class RecheckPendingReferencesUseCase {
  constructor(private readonly deps: RecheckPendingReferencesDependencies) {}

  async execute(batchSize: number): Promise<RecheckPendingReferencesResult> {
    const { wagerTransactions, clock } = this.deps;
    const due = await wagerTransactions.findDueReferenceChecks(clock.now(), batchSize);
    const result: RecheckPendingReferencesResult = {
      due: due.length,
      completed: 0,
      rescheduled: 0,
      skipped: 0,
      errors: new Map(),
    };

    for (const candidate of due) {
      try {
        result[await this.recheck(candidate)] += 1;
      } catch (error) {
        result.errors.set(candidate.id, error);
        if (!(this.deps.isTransientError?.(error) ?? false)) {
          await this.countFailedAttempt(candidate).catch(() => undefined);
        }
      }
    }
    return result;
  }

  private recheck(candidate: WagerTransaction): Promise<Outcome> {
    return this.withLockedTransaction(candidate, async (transaction, wallet, origin) => {
      await this.deps.processor.process(transaction, wallet, {
        ...origin,
        onMissingReference: (pending, missing) => this.onMissingReference(pending, missing, origin.now),
      });
      return transaction.status === WagerTransactionStatus.PendingReference ? 'rescheduled' : 'completed';
    });
  }

  private onMissingReference(transaction: WagerTransaction, missing: MissingReference, now: Date): void {
    if (transaction.referenceCheckAttempts < this.deps.maxAttempts) {
      transaction.markPendingReference(this.nextCheck(transaction, now));
    } else if (missing.reference === undefined) {
      transaction.reject(FailureCode.ReferenceNotFound, { observedBalance: missing.observedBalance });
    } else {
      transaction.reject(FailureCode.ReferenceNotProcessed, {
        referenceTransactionId: missing.reference.id,
        observedBalance: missing.observedBalance,
      });
    }
  }

  private countFailedAttempt(candidate: WagerTransaction): Promise<Outcome> {
    return this.withLockedTransaction(candidate, async (transaction, _wallet, origin) => {
      if (transaction.referenceCheckAttempts < this.deps.maxAttempts) {
        transaction.markPendingReference(this.nextCheck(transaction, origin.now));
        await this.deps.wagerTransactions.update(transaction);
        return 'rescheduled';
      }
      await this.deps.processor.fail(transaction, origin);
      return 'completed';
    });
  }

  /**
   * Trava a wallet, relê a transação e só segue se ela ainda estiver PENDING_REFERENCE e vencida. Depois do commit,
   * informa o novo estado ao monitor.
   */
  private async withLockedTransaction(
    candidate: WagerTransaction,
    work: (transaction: WagerTransaction, wallet: Wallet | undefined, origin: EventOrigin) => Promise<Outcome>,
  ): Promise<Outcome> {
    const { transactions, wallets, wagerTransactions, clock, ids } = this.deps;
    let changed: WagerTransaction | undefined;
    const outcome = await transactions.run(async (): Promise<Outcome> => {
      const wallet = await wallets.findByIdForUpdate(candidate.walletId);
      const transaction = await wagerTransactions.findById(candidate.id);
      const now = clock.now();
      if (
        transaction === undefined ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        transaction.nextReferenceCheckAt! > now
      ) {
        return 'skipped';
      }
      changed = transaction;
      return work(transaction, wallet, { now, correlationId: ids.next(), causationId: transaction.id });
    });
    if (changed !== undefined) {
      this.deps.monitor?.recorded(changed, 'RECHECK');
    }
    return outcome;
  }

  private nextCheck(transaction: WagerTransaction, now: Date): Date {
    const policy = this.deps.referenceCheckPolicy ?? DEFAULT_REFERENCE_CHECK_POLICY;
    return new Date(now.getTime() + exponentialBackoffDelayMs(transaction.referenceCheckAttempts + 1, policy));
  }
}
