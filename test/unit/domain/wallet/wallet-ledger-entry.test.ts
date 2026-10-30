import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/domain/shared/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: new Date('2026-10-30T12:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('accepts a balanced debit', () => {
      const entry = WalletLedgerEntry.create(props());
      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    });

    it('accepts a balanced credit', () => {
      const entry = WalletLedgerEntry.create(
        props({ direction: LedgerDirection.Credit, balanceBefore: brl('75.00'), balanceAfter: brl('100.00') }),
      );
      expect(entry.isBalanced()).toBe(true);
    });

    it('accepts a debit that empties the balance', () => {
      expect(() =>
        WalletLedgerEntry.create(props({ balanceBefore: brl('25.00'), balanceAfter: brl('0.00') })),
      ).not.toThrow();
    });

    it.each([
      ['unbalanced arithmetic', props({ balanceAfter: brl('76.00') })],
      ['wrong direction', props({ direction: LedgerDirection.Credit })],
      ['zero amount', props({ money: brl('0.00'), balanceAfter: brl('100.00') })],
      ['negative amount', props({ money: brl('25.00').negate(), balanceAfter: brl('125.00') })],
      ['negative balance after', props({ balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('25.00')) })],
      ['currency mismatch on money', props({ money: usd('25.00') })],
      ['currency mismatch on balance', props({ balanceAfter: usd('75.00') })],
    ])('rejects %s', (_, invalid) => {
      expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
    });
  });

  describe('immutability', () => {
    it('has no mutable fields', () => {
      const entry = WalletLedgerEntry.create(props());
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => {
        (entry as unknown as { money: Money }).money = brl('1.00');
      }).toThrow(TypeError);
    });

    it('is not affected by changes to the input date', () => {
      const createdAt = new Date('2026-10-30T12:00:00Z');
      const entry = WalletLedgerEntry.create(props({ createdAt }));
      createdAt.setFullYear(2000);
      expect(entry.createdAt.toISOString()).toBe('2026-10-30T12:00:00.000Z');
    });
  });

  describe('rehydrate', () => {
    it('rebuilds persisted state without revalidating', () => {
      const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
      expect(entry.isBalanced()).toBe(false);
    });
  });
});
