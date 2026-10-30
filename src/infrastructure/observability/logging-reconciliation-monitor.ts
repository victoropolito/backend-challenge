import type { WalletReconciliation } from '../../application/wallet/reconcile-wallet.use-case';
import { ReconciliationMonitor } from '../../application/wallet/reconciliation-monitor';
import type { AppLogger } from './structured-logger';

/** ReconciliationMonitor que registra cada divergência em log de aviso. */
export class LoggingReconciliationMonitor extends ReconciliationMonitor {
  constructor(private readonly logger: AppLogger) {
    super();
  }

  reconciled(reconciliation: WalletReconciliation): void {
    if (reconciliation.consistent) {
      return;
    }
    const { walletId, storedBalance, calculatedBalance, difference, checkedEntries } = reconciliation;
    this.logger.warn('Wallet balance diverges from its ledger', {
      walletId,
      storedBalance: storedBalance.toJSON().amount,
      calculatedBalance: calculatedBalance.toJSON().amount,
      difference: difference.toJSON().amount,
      currency: difference.currency,
      checkedEntries,
    });
  }
}
