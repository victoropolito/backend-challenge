import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/shared/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  INTERNAL_PROVIDER_ID,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const createdAt = new Date('2026-10-30T12:00:00Z');
const at = new Date('2026-10-30T12:00:01Z');

const props = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
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
  createdAt,
  ...overrides,
});

const pending = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  const transaction = pending(overrides);
  transaction.markProcessed(undefined, at);
  return transaction;
};

const reversal = (kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  pending({
    id: 'tx-2',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'provider-a:ext-2',
    kind,
    referenceExternalTransactionId: 'ext-1',
    ...overrides,
  });

describe('WagerTransaction', () => {
  describe('create', () => {
    it('starts PENDING with no outcome', () => {
      const transaction = pending();
      expect(transaction.status).toBe(Status.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
      expect(transaction.referenceTransactionId).toBeUndefined();
      expect(transaction.referenceCheckAttempts).toBe(0);
    });

    it('rejects the internal OPENING kind', () => {
      expect(() => pending({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    });

    it('rejects the reserved internal provider id', () => {
      expect(() => pending({ providerId: INTERNAL_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
    });

    it.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)(
      'rejects an empty %s',
      (field) => {
        expect(() => pending({ [field]: '  ' })).toThrow(InvalidWagerTransactionError);
      },
    );

    it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
      expect(() => pending({ kind })).toThrow(InvalidWagerTransactionError);
      expect(() => pending({ kind, referenceExternalTransactionId: ' ' })).toThrow(InvalidWagerTransactionError);
      expect(() => reversal(kind)).not.toThrow();
    });

    it('BET must not have a reference', () => {
      expect(() => pending({ referenceExternalTransactionId: 'ext-0' })).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Win, Kind.Loss])('%s may have a reference', (kind) => {
      expect(() => pending({ kind })).not.toThrow();
      expect(() => reversal(kind)).not.toThrow();
    });

    it('rejects a self reference', () => {
      expect(() => reversal(Kind.Refund, { externalTransactionId: 'ext-1' })).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Bet, Kind.Win])('%s rejects a zero amount', (kind) => {
      expect(() => pending({ kind, money: Money.zero('BRL') })).toThrow(InvalidWagerTransactionError);
    });

    it('LOSS accepts a zero amount', () => {
      expect(() => pending({ kind: Kind.Loss, money: Money.zero('BRL') })).not.toThrow();
    });

    it('rejects a negative amount', () => {
      expect(() => pending({ money: brl('1.00').negate() })).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('createOpening', () => {
    it('creates an internal, already processed OPENING', () => {
      const opening = WagerTransaction.createOpening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        payloadHash: 'hash-open',
        at,
      });

      expect(opening.kind).toBe(Kind.Opening);
      expect(opening.status).toBe(Status.Processed);
      expect(opening.providerId).toBe(INTERNAL_PROVIDER_ID);
      expect(opening.externalTransactionId).toBe('wallet-opening:wallet-1');
      expect(opening.processedAt).toEqual(at);
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('rejects a zero amount', () => {
      expect(() =>
        WagerTransaction.createOpening({
          id: 'tx-open',
          walletId: 'wallet-1',
          playerId: 'player-1',
          money: Money.zero('BRL'),
          payloadHash: 'hash-open',
          at,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('transitions', () => {
    it('PENDING → PROCESSED', () => {
      const transaction = processed();
      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.processedAt).toEqual(at);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('PENDING → PENDING_REFERENCE → PENDING_REFERENCE → PROCESSED', () => {
      const transaction = reversal(Kind.Refund);
      const firstCheck = new Date('2026-10-30T12:00:05Z');
      const secondCheck = new Date('2026-10-30T12:00:15Z');

      transaction.markPendingReference(firstCheck);
      expect(transaction.status).toBe(Status.PendingReference);
      expect(transaction.referenceCheckAttempts).toBe(1);
      expect(transaction.nextReferenceCheckAt).toEqual(firstCheck);

      transaction.markPendingReference(secondCheck);
      expect(transaction.referenceCheckAttempts).toBe(2);
      expect(transaction.nextReferenceCheckAt).toEqual(secondCheck);

      transaction.markProcessed('tx-1', at);
      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.referenceTransactionId).toBe('tx-1');
      expect(transaction.nextReferenceCheckAt).toBeUndefined();
    });

    it('PENDING_REFERENCE → REJECTED when the reference never shows up', () => {
      const transaction = reversal(Kind.Rollback);
      transaction.markPendingReference(at);
      transaction.reject(FailureCode.ReferenceNotFound);
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(transaction.nextReferenceCheckAt).toBeUndefined();
    });

    it('PENDING → REJECTED keeps the failure code and optional reference', () => {
      const transaction = reversal(Kind.Rollback);
      transaction.reject(FailureCode.ReversalInsufficientBalance, 'tx-1');
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.ReversalInsufficientBalance);
      expect(transaction.referenceTransactionId).toBe('tx-1');
      expect(transaction.processedAt).toBeUndefined();
    });

    it('PENDING → FAILED', () => {
      const transaction = pending();
      transaction.fail(FailureCode.ProcessingError);
      expect(transaction.status).toBe(Status.Failed);
      expect(transaction.failureCode).toBe(FailureCode.ProcessingError);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('does not keep a resolved reference on a transaction without reference', () => {
      expect(() => pending().reject(FailureCode.InsufficientBalance, 'tx-0')).toThrow(InvalidTransactionStateError);
    });

    it('does not reject with an infrastructure failure code', () => {
      expect(() => pending().reject(FailureCode.ProcessingError)).toThrow(InvalidTransactionStateError);
    });

    it('requires the resolved reference id when processing a referencing transaction', () => {
      expect(() => reversal(Kind.Refund).markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    });

    it('does not accept a reference id for a transaction without reference', () => {
      expect(() => pending().markProcessed('tx-0', at)).toThrow(InvalidTransactionStateError);
    });

    it('PENDING_REFERENCE only applies to transactions with a reference', () => {
      expect(() => pending().markPendingReference(at)).toThrow(InvalidTransactionStateError);
    });

    describe('terminal states do not change', () => {
      const terminals: [string, () => WagerTransaction][] = [
        ['PROCESSED', () => processed()],
        [
          'REJECTED',
          () => {
            const t = pending();
            t.reject(FailureCode.InsufficientBalance);
            return t;
          },
        ],
        [
          'FAILED',
          () => {
            const t = pending();
            t.fail(FailureCode.ProcessingError);
            return t;
          },
        ],
      ];

      const transitions: [string, (t: WagerTransaction) => void][] = [
        ['markProcessed', (t) => t.markProcessed(undefined, at)],
        ['markPendingReference', (t) => t.markPendingReference(at)],
        ['reject', (t) => t.reject(FailureCode.InsufficientBalance)],
        ['fail', (t) => t.fail(FailureCode.ProcessingError)],
      ];

      for (const [statusName, build] of terminals) {
        for (const [transitionName, transition] of transitions) {
          it(`${statusName} rejects ${transitionName}`, () => {
            const transaction = build();
            const before = { status: transaction.status, failureCode: transaction.failureCode };
            expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
            expect({ status: transaction.status, failureCode: transaction.failureCode }).toEqual(before);
          });
        }
      }
    });
  });

  describe('domain queries', () => {
    it('only LOSS does not affect the balance', () => {
      expect(pending({ kind: Kind.Loss }).affectsBalance()).toBe(false);
      for (const kind of [Kind.Bet, Kind.Win]) {
        expect(pending({ kind }).affectsBalance()).toBe(true);
      }
      for (const kind of [Kind.Refund, Kind.Rollback]) {
        expect(reversal(kind).affectsBalance()).toBe(true);
      }
    });

    it('only REFUND and ROLLBACK require a reference', () => {
      expect(pending().requiresReference()).toBe(false);
      expect(pending({ kind: Kind.Win }).requiresReference()).toBe(false);
      expect(reversal(Kind.Refund).requiresReference()).toBe(true);
      expect(reversal(Kind.Rollback).requiresReference()).toBe(true);
    });

    it('matches the payload by hash', () => {
      expect(pending().matchesPayload('hash-1')).toBe(true);
      expect(pending().matchesPayload('hash-2')).toBe(false);
    });
  });

  describe('ledgerDirectionFor', () => {
    it('BET debits; WIN and REFUND credit', () => {
      expect(pending().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(pending({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(reversal(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('LOSS has no direction', () => {
      expect(() => pending({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ])('ROLLBACK of %s goes %s', (referenceKind, expected) => {
      const reference =
        referenceKind === Kind.Refund
          ? reversal(Kind.Refund, { id: 'tx-r', externalTransactionId: 'ext-1', referenceExternalTransactionId: 'ext-0' })
          : pending({ kind: referenceKind });
      expect(reversal(Kind.Rollback).ledgerDirectionFor(reference)).toBe(expected);
    });

    it('ROLLBACK needs a valid reference', () => {
      const rollback = reversal(Kind.Rollback);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
      expect(() => rollback.ledgerDirectionFor(pending({ kind: Kind.Loss }))).toThrow(InvalidTransactionStateError);
    });
  });

  describe('checkReference', () => {
    it('accepts a matching processed BET for REFUND', () => {
      expect(reversal(Kind.Refund).checkReference(processed())).toBeUndefined();
    });

    it.each([
      ['provider', { providerId: 'provider-b' }],
      ['external id', { externalTransactionId: 'ext-other' }],
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['round', { roundId: 'round-2' }],
      ['currency', { money: usd('25.00') }],
    ])('rejects a reference with a different %s', (_, overrides) => {
      expect(reversal(Kind.Refund).checkReference(processed(overrides))).toBe(FailureCode.ReferenceMismatch);
    });

    it('rejects itself as reference', () => {
      const refund = reversal(Kind.Refund);
      expect(refund.checkReference(refund)).toBe(FailureCode.ReferenceMismatch);
    });

    it.each([
      [Kind.Refund, Kind.Win, FailureCode.ReferenceKindNotAllowed],
      [Kind.Refund, Kind.Loss, FailureCode.ReferenceKindNotAllowed],
      [Kind.Rollback, Kind.Loss, FailureCode.ReferenceKindNotAllowed],
      [Kind.Win, Kind.Win, FailureCode.ReferenceKindNotAllowed],
      [Kind.Rollback, Kind.Bet, undefined],
      [Kind.Rollback, Kind.Win, undefined],
      [Kind.Win, Kind.Bet, undefined],
      [Kind.Loss, Kind.Bet, undefined],
    ])('%s referencing %s → %p', (kind, referenceKind, expected) => {
      expect(reversal(kind).checkReference(processed({ kind: referenceKind }))).toBe(expected);
    });

    it('ROLLBACK accepts a processed REFUND', () => {
      const refund = reversal(Kind.Refund, { id: 'tx-r', externalTransactionId: 'ext-1', referenceExternalTransactionId: 'ext-0' });
      refund.markProcessed('tx-0', at);
      expect(reversal(Kind.Rollback).checkReference(refund)).toBeUndefined();
    });

    it('rejects a reference that is not PROCESSED', () => {
      expect(reversal(Kind.Refund).checkReference(pending())).toBe(FailureCode.ReferenceNotProcessed);
      const rejected = pending();
      rejected.reject(FailureCode.InsufficientBalance);
      expect(reversal(Kind.Refund).checkReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
    });

    it.each([Kind.Refund, Kind.Rollback])('%s must match the reference amount', (kind) => {
      expect(reversal(kind, { money: brl('24.99') }).checkReference(processed())).toBe(FailureCode.ReferenceAmountMismatch);
    });

    it('WIN may have a different amount than its BET', () => {
      expect(reversal(Kind.Win, { money: brl('100.00') }).checkReference(processed())).toBeUndefined();
    });
  });

  describe('rehydrate', () => {
    it('restores terminal state without revalidating', () => {
      const transaction = WagerTransaction.rehydrate({
        ...props({ kind: Kind.Opening, providerId: INTERNAL_PROVIDER_ID }),
        status: Status.Rejected,
        referenceTransactionId: undefined,
        failureCode: FailureCode.InsufficientBalance,
        processedAt: undefined,
        referenceCheckAttempts: 0,
        nextReferenceCheckAt: undefined,
      });

      expect(transaction.kind).toBe(Kind.Opening);
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientBalance);
      expect(() => transaction.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    });
  });
});
