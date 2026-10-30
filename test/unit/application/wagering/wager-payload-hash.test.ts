import { describe, expect, it } from 'bun:test';
import { payloadHash } from '../../../../src/application/shared/payload-hash';
import { wagerPayloadHash, type WagerPayloadFields } from '../../../../src/application/wagering/wager-payload-hash';
import { Money } from '../../../../src/domain/shared/money';
import { WagerTransactionKind as Kind } from '../../../../src/domain/wagering/wager-transaction';

const fields = (overrides: Partial<WagerPayloadFields> = {}): WagerPayloadFields => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: Kind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
  referenceExternalTransactionId: undefined,
  ...overrides,
});

describe('wagerPayloadHash', () => {
  it('hashes exactly the business fields, with an absent reference as null', () => {
    expect(wagerPayloadHash(fields())).toBe(
      payloadHash({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: 'player-1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: null,
      }),
    );
  });

  it('ignores transport metadata such as the idempotency key and correlation id', () => {
    const withMetadata = { ...fields(), idempotencyKey: 'k', correlationId: 'c' } as WagerPayloadFields;
    expect(wagerPayloadHash(withMetadata)).toBe(wagerPayloadHash(fields()));
  });

  it('uses the normalized amount', () => {
    expect(wagerPayloadHash(fields({ money: Money.from({ amount: '25', currency: 'BRL' }) }))).toBe(
      wagerPayloadHash(fields()),
    );
  });

  it.each<[string, Partial<WagerPayloadFields>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: Kind.Win }],
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['reference', { referenceExternalTransactionId: 'transaction-100' }],
  ])('changes when %s changes', (_, overrides) => {
    expect(wagerPayloadHash(fields(overrides))).not.toBe(wagerPayloadHash(fields()));
  });
});
