import { describe, expect, it } from 'bun:test';
import type { WalletReconciliation } from '../../../src/application/wallet/reconcile-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { LoggingReconciliationMonitor } from '../../../src/infrastructure/observability/logging-reconciliation-monitor';
import { RecordingLogger } from '../../support/loggers';

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
    const logger = new RecordingLogger();
    new LoggingReconciliationMonitor(logger).reconciled(reconciliation('90.00', '100.00'));

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'Wallet balance diverges from its ledger',
        fields: {
          walletId: 'wallet-1',
          storedBalance: '90.00',
          calculatedBalance: '100.00',
          difference: '-10.00',
          currency: 'BRL',
          checkedEntries: 3,
        },
      },
    ]);
  });

  it('stays quiet when the wallet is consistent', () => {
    const logger = new RecordingLogger();
    new LoggingReconciliationMonitor(logger).reconciled(reconciliation('100.00', '100.00'));

    expect(logger.entries).toEqual([]);
  });
});
