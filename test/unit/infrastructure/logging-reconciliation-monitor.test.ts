import { describe, expect, it } from 'bun:test';
import type { WalletReconciliation } from '../../../src/application/wallet/reconcile-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { LoggingReconciliationMonitor } from '../../../src/infrastructure/observability/logging-reconciliation-monitor';

const brl = (amount: string) => Money.rehydrate({ amount, currency: 'BRL' });

const reconciliation = (stored: string, calculated: string): WalletReconciliation => {
  const difference = brl(stored).subtract(brl(calculated));
  return {
    walletId: 'wallet-1',
    storedBalance: brl(stored),
    calculatedBalance: brl(calculated),
    difference,
    consistent: difference.isZero(),
    checkedEntries: 3,
    checkedAt: new Date('2026-10-30T12:00:00Z'),
  };
};

describe('LoggingReconciliationMonitor', () => {
  it('logs a divergence with both balances and the difference', () => {
    const warnings: string[] = [];
    new LoggingReconciliationMonitor({ warn: (message) => warnings.push(message) }).reconciled(reconciliation('90.00', '100.00'));

    expect(warnings).toEqual([
      'Wallet wallet-1 balance diverges from its ledger: stored 90.00 BRL, calculated 100.00 BRL, difference -10.00 BRL, 3 entries checked',
    ]);
  });

  it('stays quiet when the wallet is consistent', () => {
    const warnings: string[] = [];
    new LoggingReconciliationMonitor({ warn: (message) => warnings.push(message) }).reconciled(reconciliation('100.00', '100.00'));

    expect(warnings).toEqual([]);
  });
});
