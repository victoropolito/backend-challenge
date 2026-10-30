import { describe, expect, it } from 'bun:test';
import { InboxMessage, InvalidInboxStateError, type ReceiveInboxProps } from '../../../../src/domain/messaging/inbox-message';

const receivedAt = new Date('2026-10-30T12:00:00Z');
const processedAt = new Date('2026-10-30T12:00:01Z');

const props = (overrides: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps => ({
  messageId: 'msg-1',
  consumerName: 'wager-transactions',
  payloadHash: 'hash-1',
  receivedAt,
  ...overrides,
});

describe('InboxMessage', () => {
  it('is received unprocessed', () => {
    const message = InboxMessage.receive(props());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.receivedAt).toEqual(receivedAt);
  });

  it.each(['messageId', 'consumerName', 'payloadHash'] as const)('rejects an empty %s', (field) => {
    expect(() => InboxMessage.receive(props({ [field]: ' ' }))).toThrow(InvalidInboxStateError);
  });

  it('marks as processed once', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(processedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
    expect(() => message.markProcessed(processedAt)).toThrow(InvalidInboxStateError);
  });

  it('matches the payload by hash', () => {
    const message = InboxMessage.receive(props());
    expect(message.matchesPayload('hash-1')).toBe(true);
    expect(message.matchesPayload('hash-2')).toBe(false);
  });

  it('rehydrates processed state', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt });
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(processedAt)).toThrow(InvalidInboxStateError);
  });
});
