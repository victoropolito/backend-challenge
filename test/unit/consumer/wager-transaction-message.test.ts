import { describe, expect, it } from 'bun:test';
import {
  MalformedMessageError,
  parseWagerTransactionMessage,
} from '../../../src/consumer/wager-transaction-message';
import { InvalidMoneyError, Money } from '../../../src/domain/shared/money';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';

const receivedAt = new Date('2026-10-30T12:00:00.000Z');

const message = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: 'player-1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...data,
  },
  ...overrides,
});

const parse = (value: unknown) => parseWagerTransactionMessage(JSON.stringify(value), receivedAt);

const malformed = (body: string): MalformedMessageError => {
  try {
    parseWagerTransactionMessage(body, receivedAt);
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedMessageError);
    return error as MalformedMessageError;
  }
  throw new Error('expected MalformedMessageError');
};

describe('parseWagerTransactionMessage', () => {
  it('builds the submission command from the message', () => {
    const parsed = parse(message());

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.receivedAt).toEqual(receivedAt);
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.command).toEqual({
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      correlationId: 'msg-123',
      causationId: 'msg-123',
    });
  });

  it('keeps the reference of reversals', () => {
    const parsed = parse(message({}, { kind: 'REFUND', referenceExternalTransactionId: 'transaction-100' }));
    expect(parsed.command.referenceExternalTransactionId).toBe('transaction-100');
  });

  it('trims identifiers', () => {
    const parsed = parse(message({ messageId: ' msg-123 ' }, { providerId: ' provider-a', idempotencyKey: 'k ' }));
    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.command.providerId).toBe('provider-a');
    expect(parsed.command.idempotencyKey).toBe('k');
  });

  it('hashes the content independently of key order', () => {
    const { data, ...envelope } = message();
    const reordered = { data: Object.fromEntries(Object.entries(data).reverse()), ...envelope };
    expect(parse(reordered).payloadHash).toBe(parse(message()).payloadHash);
    expect(parse(message({ occurredAt: '2026-07-29T15:00:01.000Z' })).payloadHash).not.toBe(parse(message()).payloadHash);
  });

  it('rejects a body that is not JSON', () => {
    expect(malformed('{"messageId":').message).toContain('not valid JSON');
  });

  it('rejects a number that cannot be hashed', () => {
    const body = JSON.stringify(message()).replace('"type"', '"extra":1e400,"type"');
    expect(malformed(body).message).toContain('cannot be hashed');
  });

  it.each<[string, unknown, string]>([
    ['an unknown type', message({ type: 'WagerTransactionCancelled' }), 'type'],
    ['a missing messageId', message({ messageId: undefined }), 'messageId'],
    ['a blank messageId', message({ messageId: '  ' }), 'messageId'],
    ['an invalid occurredAt', message({ occurredAt: 'yesterday' }), 'occurredAt'],
    ['a missing idempotencyKey', message({}, { idempotencyKey: undefined }), 'data.idempotencyKey'],
    ['a walletId that is not a UUID', message({}, { walletId: 'wallet-1' }), 'data.walletId'],
    ['an OPENING', message({}, { kind: 'OPENING' }), 'data.kind'],
    ['a numeric amount', message({}, { money: { amount: 25, currency: 'BRL' } }), 'data.money.amount'],
    ['an array', [message()], ''],
  ])('rejects %s', (_, value, path) => {
    const error = malformed(JSON.stringify(value));
    expect(error.code).toBe('MALFORMED_MESSAGE');
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });

  it('lets Money reject an amount with more than 2 decimal places', () => {
    expect(() => parse(message({}, { money: { amount: '25.001', currency: 'BRL' } }))).toThrow(InvalidMoneyError);
  });
});
