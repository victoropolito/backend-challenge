import type { WalletReconciliation } from './reconcile-wallet.use-case';

/** Recebe o resultado de cada reconciliação: registra divergências e alimenta a observabilidade. */
export abstract class ReconciliationMonitor {
  abstract reconciled(reconciliation: WalletReconciliation): void;
}
