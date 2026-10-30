import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../../src/domain/shared/money';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
  Wallet,
  type WalletMovement,
} from '../../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const openedAt = new Date('2026-10-30T12:00:00Z');
const later = new Date('2026-10-30T12:05:00Z');

const open = (initialBalance = brl('100.00')) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: openedAt,
  });

const movement = (money: Money, overrides: Partial<WalletMovement> = {}): WalletMovement => ({
  entryId: 'entry-1',
  transactionId: 'tx-1',
  money,
  at: later,
  ...overrides,
});

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with the initial balance and currency', () => {
      const { wallet } = open();
      expect(wallet.version).toBe(1);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);
    });

    it('records the initial balance as an opening credit', () => {
      const { openingEntry } = open();
      expect(openingEntry).toBeDefined();
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(openingEntry?.balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('does not create a ledger entry for a zero initial balance', () => {
      const { wallet, openingEntry } = open(Money.zero('BRL'));
      expect(openingEntry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });

    it('rejects a negative initial balance', () => {
      expect(() => open(Money.rehydrate({ amount: '-1.00', currency: 'BRL' }))).toThrow(InvalidWalletOperationError);
    });

    it('rejects an empty playerId', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: ' ',
          initialBalance: brl('1.00'),
          openingTransactionId: 'tx',
          openingEntryId: 'entry',
          at: openedAt,
        }),
      ).toThrow(InvalidWalletOperationError);
    });
  });

  describe('debit', () => {
    it('decreases the balance, bumps the version and returns the matching entry', () => {
      const { wallet } = open();
      const entry = wallet.debit(movement(brl('25.00')));

      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(later);
      expect(entry).toMatchObject({ id: 'entry-1', walletId: 'wallet-1', transactionId: 'tx-1' });
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows debiting the whole balance', () => {
      const { wallet } = open();
      wallet.debit(movement(brl('100.00')));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejects a debit beyond the balance without changing state', () => {
      const { wallet } = open();
      expect(() => wallet.debit(movement(brl('100.01')))).toThrow(InsufficientBalanceError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(openedAt);
    });

    it('accepts only one of two competing 80.00 bets on a 100.00 balance', () => {
      const { wallet } = open();
      wallet.debit(movement(brl('80.00'), { transactionId: 'bet-1' }));
      expect(() => wallet.debit(movement(brl('80.00'), { transactionId: 'bet-2' }))).toThrow(InsufficientBalanceError);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });
  });

  describe('credit', () => {
    it('increases the balance, bumps the version and returns the matching entry', () => {
      const { wallet } = open();
      const entry = wallet.credit(movement(brl('50.00')));

      expect(wallet.balance.equals(brl('150.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('150.00'))).toBe(true);
    });
  });

  describe('invalid movements', () => {
    it.each([
      ['debit', (wallet: Wallet, m: WalletMovement) => wallet.debit(m)],
      ['credit', (wallet: Wallet, m: WalletMovement) => wallet.credit(m)],
    ])('%s rejects a different currency without changing state', (_, operation) => {
      const { wallet } = open();
      expect(() => operation(wallet, movement(usd('1.00')))).toThrow(CurrencyMismatchError);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it.each([
      ['debit', (wallet: Wallet, m: WalletMovement) => wallet.debit(m)],
      ['credit', (wallet: Wallet, m: WalletMovement) => wallet.credit(m)],
    ])('%s rejects zero and negative amounts', (_, operation) => {
      const { wallet } = open();
      expect(() => operation(wallet, movement(Money.zero('BRL')))).toThrow(InvalidWalletOperationError);
      expect(() => operation(wallet, movement(brl('1.00').negate()))).toThrow(InvalidWalletOperationError);
      expect(wallet.version).toBe(1);
    });

    it('canDebit rejects a different currency', () => {
      expect(() => open().wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('ledger consistency', () => {
    it('keeps the balance equal to the sum of its ledger entries', () => {
      const { wallet, openingEntry } = open();
      const entries = [
        openingEntry!,
        wallet.debit(movement(brl('30.00'), { entryId: 'e1' })),
        wallet.credit(movement(brl('12.34'), { entryId: 'e2' })),
        wallet.debit(movement(brl('82.34'), { entryId: 'e3' })),
      ];

      const calculated = entries.reduce(
        (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
        Money.zero('BRL'),
      );

      expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(calculated.equals(wallet.balance)).toBe(true);
      expect(wallet.version).toBe(1 + entries.length - 1);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
      }
    });
  });

  describe('rehydrate', () => {
    it('restores persisted state as-is', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('975.00'),
        version: 7,
        createdAt: openedAt,
        updatedAt: later,
      });

      expect(wallet.balance.equals(brl('975.00'))).toBe(true);
      expect(wallet.version).toBe(7);
      wallet.credit(movement(brl('25.00')));
      expect(wallet.version).toBe(8);
    });
  });

  it('does not expose a mutable updatedAt', () => {
    const { wallet } = open();
    wallet.updatedAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(openedAt);
  });
});
