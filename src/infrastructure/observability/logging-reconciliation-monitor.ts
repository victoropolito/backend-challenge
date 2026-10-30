import type { WalletReconciliation } from '../../application/wallet/reconcile-wallet.use-case';
import { ReconciliationMonitor } from '../../application/wallet/reconciliation-monitor';

export interface ReconciliationLogger {
  warn(message: string): void;
}

/** ReconciliationMonitor que registra cada divergência em log de aviso. */
export class LoggingReconciliationMonitor extends ReconciliationMonitor {
  constructor(private readonly logger: ReconciliationLogger) {
    super();
  }

  reconciled(reconciliation: WalletReconciliation): void {
    if (reconciliation.consistent) {
      return;
    }
    const { walletId, storedBalance, calculatedBalance, difference, checkedEntries } = reconciliation;
    this.logger.warn(
      `Wallet ${walletId} balance diverges from its ledger: stored ${storedBalance}, ` +
        `calculated ${calculatedBalance}, difference ${difference}, ${checkedEntries} entries checked`,
    );
  }
}
