import { describe, expect, it } from 'bun:test';
import {
  ExternalTransactionIdConflictError,
  IdempotencyConflictError,
} from '../../../src/application/wagering/submit-wager-transaction.use-case';
import type { WalletReconciliation } from '../../../src/application/wallet/reconcile-wallet.use-case';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { LoggingWageringMonitor } from '../../../src/infrastructure/observability/logging-wagering-monitor';
import {
  CompositeReconciliationMonitor,
  CompositeWageringMonitor,
  MetricsReconciliationMonitor,
  MetricsWageringMonitor,
} from '../../../src/infrastructure/observability/metrics-monitors';
import { WageringMetrics } from '../../../src/infrastructure/observability/wagering-metrics';
import { RecordingLogger } from '../../support/loggers';
import { sampleValue } from '../../support/metrics';

const at = new Date('2026-10-30T12:00:00Z');
const brl = (amount: string) => Money.rehydrate({ amount, currency: 'BRL' });

const bet = () =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: at,
  });

const applied = () => {
  const transaction = bet();
  transaction.markProcessed(undefined, brl('75.00'), at);
  return transaction;
};

const reconciliation = (consistent: boolean): WalletReconciliation => ({
  walletId: 'wallet-1',
  storedBalance: brl('10.00'),
  calculatedBalance: brl(consistent ? '10.00' : '20.00'),
  difference: brl(consistent ? '0.00' : '-10.00'),
  consistent,
  checkedEntries: 1,
  checkedAt: at,
});

describe('MetricsWageringMonitor', () => {
  it('counts outcomes by kind, status, failure code and origin', async () => {
    const metrics = new WageringMetrics();
    const monitor = new MetricsWageringMonitor(metrics);
    const rejected = bet();
    rejected.reject(FailureCode.InsufficientBalance, { observedBalance: brl('10.00') });

    monitor.recorded(applied(), 'SUBMISSION');
    monitor.recorded(applied(), 'SUBMISSION');
    monitor.recorded(rejected, 'RECHECK');

    const text = await metrics.render();
    expect(
      sampleValue(text, 'wagering_transactions_total{kind="BET",status="PROCESSED",failure_code="",origin="SUBMISSION"}'),
    ).toBe(2);
    expect(
      sampleValue(
        text,
        'wagering_transactions_total{kind="BET",status="REJECTED",failure_code="INSUFFICIENT_BALANCE",origin="RECHECK"}',
      ),
    ).toBe(1);
  });

  it('counts replays and conflicts', async () => {
    const metrics = new WageringMetrics();
    const monitor = new MetricsWageringMonitor(metrics);

    monitor.replayed(applied());
    monitor.conflicted(new IdempotencyConflictError('provider-a', 'key', 'tx-1'));
    monitor.conflicted(new ExternalTransactionIdConflictError('provider-a', 'ext-1', 'tx-1'));

    const text = await metrics.render();
    expect(sampleValue(text, 'wagering_idempotent_replays_total{kind="BET",status="PROCESSED"}')).toBe(1);
    expect(sampleValue(text, 'wagering_submission_conflicts_total{code="IDEMPOTENCY_CONFLICT"}')).toBe(1);
    expect(sampleValue(text, 'wagering_submission_conflicts_total{code="EXTERNAL_TRANSACTION_ID_CONFLICT"}')).toBe(1);
  });
});

describe('MetricsReconciliationMonitor', () => {
  it('counts consistent and divergent reconciliations', async () => {
    const metrics = new WageringMetrics();
    const monitor = new MetricsReconciliationMonitor(metrics);

    monitor.reconciled(reconciliation(true));
    monitor.reconciled(reconciliation(false));
    monitor.reconciled(reconciliation(false));

    const text = await metrics.render();
    expect(sampleValue(text, 'wagering_reconciliations_total{result="consistent"}')).toBe(1);
    expect(sampleValue(text, 'wagering_reconciliations_total{result="divergent"}')).toBe(2);
  });
});

describe('composite monitors', () => {
  it('forward every notification to all monitors', async () => {
    const metrics = new WageringMetrics();
    const logger = new RecordingLogger();
    const wagering = new CompositeWageringMonitor(new LoggingWageringMonitor(logger), new MetricsWageringMonitor(metrics));
    const reconciling = new CompositeReconciliationMonitor(new MetricsReconciliationMonitor(metrics));

    wagering.recorded(applied(), 'SUBMISSION');
    wagering.replayed(applied());
    wagering.conflicted(new IdempotencyConflictError('provider-a', 'key', 'tx-1'));
    reconciling.reconciled(reconciliation(true));

    expect(logger.entries.map((entry) => entry.message)).toEqual([
      'Wager transaction recorded',
      'Idempotent replay',
      'Submission conflict',
    ]);
    const text = await metrics.render();
    expect(
      sampleValue(text, 'wagering_transactions_total{kind="BET",status="PROCESSED",failure_code="",origin="SUBMISSION"}'),
    ).toBe(1);
    expect(sampleValue(text, 'wagering_idempotent_replays_total{kind="BET",status="PROCESSED"}')).toBe(1);
    expect(sampleValue(text, 'wagering_submission_conflicts_total{code="IDEMPOTENCY_CONFLICT"}')).toBe(1);
    expect(sampleValue(text, 'wagering_reconciliations_total{result="consistent"}')).toBe(1);
  });
});
