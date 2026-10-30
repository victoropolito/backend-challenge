import { describe, expect, it } from 'bun:test';
import { InvalidIntegrationEventError, type EventContext } from '../../../../src/domain/events/integration-event';
import { WalletBalanceChanged } from '../../../../src/domain/events/wallet-balance-changed';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../../src/domain/events/wager-transaction-events';
import { Money } from '../../../../src/domain/shared/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  type CreateWagerTransactionProps,
} from '../../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-30T12:00:00Z');

const ctx: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: at,
};

const transaction = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    createdAt: at,
    ...overrides,
  });

const openWallet = () =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('1000.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at,
  }).wallet;

describe('IntegrationEvent envelope', () => {
  it('serializes the envelope with ISO date, type and version', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const event = WagerTransactionProcessed.from(tx, ctx);

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-30T12:00:00.000Z',
      version: 1,
      data: expect.any(Object),
    });
  });

  it('omits causationId when absent', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const json = WagerTransactionProcessed.from(tx, { ...ctx, causationId: undefined }).toJSON();
    expect('causationId' in json).toBe(false);
  });

  it('round-trips through JSON as plain data, never Money instances', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
    expect(event.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('has deeply immutable data', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => {
      (event.data.money as { amount: string }).amount = '0.00';
    }).toThrow(TypeError);
  });

  it('toJSON returns a copy that does not affect the event', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const event = WagerTransactionProcessed.from(tx, ctx);
    const json = event.toJSON();
    json.data.money.amount = '0.00';
    expect(event.data.money.amount).toBe('25.00');
  });

  it.each(['eventId', 'correlationId'] as const)('rejects an empty %s', (field) => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    expect(() => WagerTransactionProcessed.from(tx, { ...ctx, [field]: '' })).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionProcessed', () => {
  it('carries the transaction and the observed balance', () => {
    const tx = transaction();
    tx.markProcessed(undefined, brl('975.00'), at);
    const event = WagerTransactionProcessed.from(tx, ctx);

    expect(event.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      balance: { amount: '975.00', currency: 'BRL' },
      processedAt: '2026-10-30T12:00:00.000Z',
    });
  });

  it('is emitted for LOSS too', () => {
    const tx = transaction({ kind: Kind.Loss, money: Money.zero('BRL') });
    tx.markProcessed(undefined, brl('1000.00'), at);
    expect(WagerTransactionProcessed.from(tx, ctx).data.kind).toBe(Kind.Loss);
  });

  it('includes the resolved reference', () => {
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' });
    tx.markProcessed('tx-0', brl('1025.00'), at);
    const { data } = WagerTransactionProcessed.from(tx, ctx);
    expect(data.referenceExternalTransactionId).toBe('ext-0');
    expect(data.referenceTransactionId).toBe('tx-0');
  });

  it('requires a PROCESSED transaction', () => {
    expect(() => WagerTransactionProcessed.from(transaction(), ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe('WagerTransactionRejected', () => {
  it('carries the failure code', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientBalance);
    const event = WagerTransactionRejected.from(tx, ctx);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.aggregateId).toBe('tx-1');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(event.data.referenceTransactionId).toBeNull();
  });

  it('carries the observed balance when there is one', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientBalance, { observedBalance: brl('10.00') });
    expect(WagerTransactionRejected.from(tx, ctx).data.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('has a null balance when none was observed', () => {
    const tx = transaction();
    tx.reject(FailureCode.WalletNotFound);
    expect(WagerTransactionRejected.from(tx, ctx).data.balance).toBeNull();
  });

  it('requires a REJECTED transaction', () => {
    const tx = transaction();
    tx.fail(FailureCode.ProcessingError);
    expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe('WagerTransactionPendingReference', () => {
  it('carries the missing reference and the next check', () => {
    const tx = transaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-0' });
    tx.markPendingReference(new Date('2026-10-30T12:00:05Z'));
    const event = WagerTransactionPendingReference.from(tx, ctx);

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('ext-0');
    expect(event.data.referenceCheckAttempts).toBe(1);
    expect(event.data.nextReferenceCheckAt).toBe('2026-10-30T12:00:05.000Z');
  });

  it('requires a PENDING_REFERENCE transaction', () => {
    const tx = transaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-0' });
    expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow(InvalidIntegrationEventError);
  });
});

describe('WalletBalanceChanged', () => {
  it('describes the movement from the ledger entry', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('25.00'), at });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('rejects an entry from another wallet', () => {
    const wallet = openWallet();
    const other = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-open-2',
      openingEntryId: 'entry-open-2',
      at,
    }).wallet;
    const entry = other.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('25.00'), at });
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(InvalidIntegrationEventError);
  });

  it('rejects an entry that is not the latest movement', () => {
    const wallet = openWallet();
    const first = wallet.debit({ entryId: 'entry-1', transactionId: 'tx-1', money: brl('25.00'), at });
    wallet.debit({ entryId: 'entry-2', transactionId: 'tx-2', money: brl('25.00'), at });
    expect(() => WalletBalanceChanged.from(wallet, first, ctx)).toThrow(InvalidIntegrationEventError);
  });
});
