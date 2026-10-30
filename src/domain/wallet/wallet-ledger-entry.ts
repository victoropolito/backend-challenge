import { DomainError } from '../shared/domain-error';
import type { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/** Lançamento imutável do ledger de uma wallet: registra uma movimentação e o saldo antes/depois dela. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Cria um lançamento novo validando moeda, valor positivo, saldos não negativos e a aritmética. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter } = entry;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('Ledger entry amounts must share the same currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(`Ledger entry amount must be positive, got ${money}`);
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry balances must not be negative');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced ledger entry: ${balanceBefore} ${entry.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter, conforme a direção. */
  isBalanced(): boolean {
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) {
      return false;
    }
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
