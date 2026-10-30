import { DomainError } from '../shared/domain-error';
import { CurrencyMismatchError, Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Ausente quando o saldo inicial é zero, pois não há movimentação. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Insufficient balance: ${balance} available, ${requested} requested`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';
}

/** Aggregate root da carteira de um jogador numa moeda; toda mudança de saldo produz um lançamento no ledger. */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Abre a wallet com version 1; um saldo inicial positivo gera o lançamento de abertura. */
  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, at } = props;
    if (props.playerId.trim() === '') {
      throw new InvalidWalletOperationError('playerId must not be empty');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(`Initial balance must not be negative, got ${initialBalance}`);
    }

    const currency = initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, initialBalance, 1, new Date(at), new Date(at));
    const openingEntry = initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: initialBalance,
          createdAt: at,
        });

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência, sem revalidar regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debita o valor; lança InsufficientBalanceError se o saldo não cobrir. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientBalanceError(this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(movement.money) : balanceBefore.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(`Movement amount must be positive, got ${money}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
