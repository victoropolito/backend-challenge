import type { MoneyProps } from '../shared/money';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { IntegrationEvent, InvalidIntegrationEventError, type EventContext } from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitido somente quando o saldo de uma wallet muda, a partir do lançamento recém-criado. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(ctx: EventContext, data: WalletBalanceChangedData) {
    super({ ...ctx, aggregateId: data.walletId, data });
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(`Ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
    }
    if (!entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidIntegrationEventError(`Ledger entry ${entry.id} is not the latest movement of wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged(ctx, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    });
  }
}
