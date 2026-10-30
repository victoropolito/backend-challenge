import type {
  ExternalTransactionIdConflictError,
  IdempotencyConflictError,
} from '../../application/wagering/submit-wager-transaction.use-case';
import { WageringMonitor, type WagerTransactionOrigin } from '../../application/wagering/wagering-monitor';
import type { WalletReconciliation } from '../../application/wallet/reconcile-wallet.use-case';
import { ReconciliationMonitor } from '../../application/wallet/reconciliation-monitor';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WageringMetrics } from './wagering-metrics';

/** WageringMonitor que conta desfechos, replays e conflitos de submissão. */
export class MetricsWageringMonitor extends WageringMonitor {
  constructor(private readonly metrics: WageringMetrics) {
    super();
  }

  recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void {
    this.metrics.transactions.inc({
      kind: transaction.kind,
      status: transaction.status,
      failure_code: transaction.failureCode ?? '',
      origin,
    });
  }

  replayed(transaction: WagerTransaction): void {
    this.metrics.idempotentReplays.inc({ kind: transaction.kind, status: transaction.status });
  }

  conflicted(conflict: IdempotencyConflictError | ExternalTransactionIdConflictError): void {
    this.metrics.submissionConflicts.inc({ code: conflict.code });
  }
}

/** ReconciliationMonitor que conta reconciliações consistentes e divergentes. */
export class MetricsReconciliationMonitor extends ReconciliationMonitor {
  constructor(private readonly metrics: WageringMetrics) {
    super();
  }

  reconciled(reconciliation: WalletReconciliation): void {
    this.metrics.reconciliations.inc({ result: reconciliation.consistent ? 'consistent' : 'divergent' });
  }
}

/** Repassa cada notificação a todos os monitores (log e métricas). */
export class CompositeWageringMonitor extends WageringMonitor {
  private readonly monitors: WageringMonitor[];

  constructor(...monitors: WageringMonitor[]) {
    super();
    this.monitors = monitors;
  }

  recorded(transaction: WagerTransaction, origin: WagerTransactionOrigin): void {
    this.monitors.forEach((monitor) => monitor.recorded(transaction, origin));
  }

  replayed(transaction: WagerTransaction): void {
    this.monitors.forEach((monitor) => monitor.replayed(transaction));
  }

  conflicted(conflict: IdempotencyConflictError | ExternalTransactionIdConflictError): void {
    this.monitors.forEach((monitor) => monitor.conflicted(conflict));
  }
}

/** Repassa cada reconciliação a todos os monitores (log e métricas). */
export class CompositeReconciliationMonitor extends ReconciliationMonitor {
  private readonly monitors: ReconciliationMonitor[];

  constructor(...monitors: ReconciliationMonitor[]) {
    super();
    this.monitors = monitors;
  }

  reconciled(reconciliation: WalletReconciliation): void {
    this.monitors.forEach((monitor) => monitor.reconciled(reconciliation));
  }
}
