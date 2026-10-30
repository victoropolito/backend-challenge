import type { Money } from '../../domain/shared/money';
import type { LedgerRepository } from '../../domain/wallet/wallet-repository';
import type { Clock } from '../shared/clock';
import { isUuid } from '../shared/uuid';
import type { ReconciliationMonitor } from './reconciliation-monitor';
import { WalletNotFoundError } from './wallet-queries';

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** Saldo materializado menos saldo calculado pelo ledger. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  checkedAt: Date;
}

export interface ReconcileWalletDependencies {
  ledger: LedgerRepository;
  monitor: ReconciliationMonitor;
  clock: Clock;
}

/**
 * Compara o saldo materializado da wallet com o saldo recalculado a partir do ledger, lidos no mesmo snapshot.
 * Só verifica: uma divergência é reportada ao monitor e devolvida no resultado, nunca corrigida.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly deps: ReconcileWalletDependencies) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    const { ledger, monitor, clock } = this.deps;
    const snapshot = isUuid(walletId) ? await ledger.balanceSnapshot(walletId) : undefined;
    if (snapshot === undefined) {
      throw new WalletNotFoundError(walletId);
    }

    const difference = snapshot.storedBalance.subtract(snapshot.ledgerBalance);
    const reconciliation: WalletReconciliation = {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance: snapshot.ledgerBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: snapshot.entries,
      checkedAt: clock.now(),
    };
    monitor.reconciled(reconciliation);
    return reconciliation;
  }
}
