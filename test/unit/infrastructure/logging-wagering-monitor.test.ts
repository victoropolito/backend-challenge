import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { LoggingWageringMonitor } from '../../../src/infrastructure/observability/logging-wagering-monitor';
import { RecordingLogger } from '../../support/loggers';

const at = new Date('2026-10-30T12:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const transaction = (kind = Kind.Bet, referenceExternalTransactionId?: string) =>
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
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId,
    createdAt: at,
  });

const identifiers = {
  transactionId: 'tx-1',
  walletId: 'wallet-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
};

describe('LoggingWageringMonitor', () => {
  it('logs a recorded outcome with the identifiers, never the amount or the balance', () => {
    const logger = new RecordingLogger();
    const tx = transaction();
    tx.reject(FailureCode.InsufficientBalance, { observedBalance: brl('10.00') });

    new LoggingWageringMonitor(logger).recorded(tx, 'SUBMISSION');

    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'Wager transaction recorded',
        fields: { ...identifiers, kind: 'BET', status: 'REJECTED', origin: 'SUBMISSION', failureCode: 'INSUFFICIENT_BALANCE' },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain('25.00');
    expect(JSON.stringify(logger.entries)).not.toContain('10.00');
  });

  it('a FAILED transaction is an error', () => {
    const logger = new RecordingLogger();
    const tx = transaction(Kind.Win, 'ext-0');
    tx.markPendingReference(at);
    tx.fail(FailureCode.ProcessingError);

    new LoggingWageringMonitor(logger).recorded(tx, 'RECHECK');

    expect(logger.entries[0]).toMatchObject({ level: 'error', fields: { status: 'FAILED', failureCode: 'PROCESSING_ERROR' } });
  });

  it('a recheck that keeps waiting is debug; the first wait is info', () => {
    const logger = new RecordingLogger();
    const tx = transaction(Kind.Win, 'ext-0');
    tx.markPendingReference(at);
    const monitor = new LoggingWageringMonitor(logger);

    monitor.recorded(tx, 'SUBMISSION');
    monitor.recorded(tx, 'RECHECK');

    expect(logger.entries.map((entry) => entry.level)).toEqual(['info', 'debug']);
    expect(logger.entries[1]!.fields).toMatchObject({ referenceCheckAttempts: 1 });
  });

  it('logs replays', () => {
    const logger = new RecordingLogger();
    const tx = transaction();
    tx.markProcessed(undefined, brl('75.00'), at);

    new LoggingWageringMonitor(logger).replayed(tx);

    expect(logger.entries).toEqual([
      { level: 'info', message: 'Idempotent replay', fields: { ...identifiers, kind: 'BET', status: 'PROCESSED' } },
    ]);
  });
});
