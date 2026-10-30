import { describe, expect, it } from 'bun:test';
import { WagerTransactionRejected } from '../../../../src/domain/events/wager-transaction-events';
import { DEFAULT_OUTBOX_RETRY_POLICY, InvalidOutboxStateError, OutboxMessage } from '../../../../src/domain/messaging/outbox-message';
import { Money } from '../../../../src/domain/shared/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind } from '../../../../src/domain/wagering/wager-transaction';

const occurredAt = new Date('2026-10-30T12:00:00Z');
const seconds = (s: number) => new Date(occurredAt.getTime() + s * 1_000);

const event = () => {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    createdAt: occurredAt,
  });
  tx.reject(FailureCode.InsufficientBalance);
  return WagerTransactionRejected.from(tx, { eventId: 'event-1', correlationId: 'corr-1', occurredAt });
};

describe('OutboxMessage', () => {
  describe('enqueue', () => {
    it('stores the serialized envelope, keyed by eventId', () => {
      const source = event();
      const message = OutboxMessage.enqueue(source);

      expect(message.id).toBe('event-1');
      expect(message.aggregateId).toBe('tx-1');
      expect(message.eventType).toBe('WagerTransactionRejected');
      expect(message.occurredAt).toEqual(occurredAt);
      expect(message.payload).toEqual(source.toJSON() as unknown as Record<string, unknown>);
    });

    it('starts pending, due immediately, with no attempts', () => {
      const message = OutboxMessage.enqueue(event());
      expect(message.attempts).toBe(0);
      expect(message.nextAttemptAt).toBeUndefined();
      expect(message.publishedAt).toBeUndefined();
      expect(message.isPending()).toBe(true);
      expect(message.isDue(occurredAt)).toBe(true);
    });

    it('has a deeply immutable payload', () => {
      const message = OutboxMessage.enqueue(event());
      const data = message.payload['data'] as { money: { amount: string } };
      expect(Object.isFrozen(message.payload)).toBe(true);
      expect(Object.isFrozen(data.money)).toBe(true);
    });
  });

  describe('markPublished', () => {
    it('stops being pending or due', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(seconds(1));
      expect(message.publishedAt).toEqual(seconds(1));
      expect(message.isPending()).toBe(false);
      expect(message.isDue(seconds(100))).toBe(false);
    });

    it('cannot be published twice', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(seconds(1));
      expect(() => message.markPublished(seconds(2))).toThrow(InvalidOutboxStateError);
      expect(message.publishedAt).toEqual(seconds(1));
    });
  });

  describe('scheduleRetry', () => {
    it('increments attempts and backs off exponentially', () => {
      const message = OutboxMessage.enqueue(event());

      message.scheduleRetry(seconds(0));
      expect(message.attempts).toBe(1);
      expect(message.nextAttemptAt).toEqual(seconds(1));
      expect(message.isDue(seconds(0.5))).toBe(false);
      expect(message.isDue(seconds(1))).toBe(true);

      message.scheduleRetry(seconds(1));
      expect(message.attempts).toBe(2);
      expect(message.nextAttemptAt).toEqual(seconds(3));

      message.scheduleRetry(seconds(3));
      expect(message.nextAttemptAt).toEqual(seconds(7));
    });

    it('caps the delay and never gives up', () => {
      const message = OutboxMessage.enqueue(event());
      for (let i = 0; i < 50; i++) {
        message.scheduleRetry(seconds(0));
      }
      expect(message.attempts).toBe(50);
      expect(message.nextAttemptAt).toEqual(new Date(occurredAt.getTime() + DEFAULT_OUTBOX_RETRY_POLICY.maxDelayMs));
      expect(message.isPending()).toBe(true);
    });

    it('accepts a custom policy', () => {
      const message = OutboxMessage.enqueue(event());
      message.scheduleRetry(seconds(0), { baseDelayMs: 10_000, maxDelayMs: 10_000 });
      expect(message.nextAttemptAt).toEqual(seconds(10));
    });

    it('cannot retry a published message', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(seconds(1));
      expect(() => message.scheduleRetry(seconds(2))).toThrow(InvalidOutboxStateError);
    });
  });

  describe('rehydrate', () => {
    it('restores persisted state', () => {
      const message = OutboxMessage.rehydrate({
        id: 'event-1',
        aggregateId: 'tx-1',
        eventType: 'WagerTransactionRejected',
        payload: { eventId: 'event-1' },
        occurredAt,
        attempts: 3,
        nextAttemptAt: seconds(10),
        publishedAt: undefined,
      });

      expect(message.attempts).toBe(3);
      expect(message.isDue(seconds(9))).toBe(false);
      expect(message.isDue(seconds(10))).toBe(true);
    });
  });
});
