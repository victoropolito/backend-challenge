import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { OutboxRepository } from '../../domain/messaging/messaging-repositories';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/shared/money';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import { Wallet } from '../../domain/wallet/wallet';
import type { LedgerRepository, WalletRepository } from '../../domain/wallet/wallet-repository';
import type { Clock } from '../shared/clock';
import type { IdGenerator } from '../shared/id-generator';
import { payloadHash } from '../shared/payload-hash';
import type { TransactionRunner } from '../shared/transaction-runner';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface CreateWalletDependencies {
  transactions: TransactionRunner;
  wallets: WalletRepository;
  ledger: LedgerRepository;
  wagerTransactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Cria a wallet de um jogador numa moeda. Saldo inicial positivo grava, na mesma transação SQL, a transação
 * OPENING, o lançamento de abertura e os eventos WagerTransactionProcessed e WalletBalanceChanged.
 * Lança WalletAlreadyExistsError se o jogador já tiver wallet na moeda.
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDependencies) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const { transactions, wallets, ledger, wagerTransactions, outbox, clock, ids } = this.deps;
    const at = clock.now();
    const walletId = ids.next();
    const openingTransactionId = ids.next();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: ids.next(),
      at,
    });

    await transactions.run(async () => {
      await wallets.insert(wallet);
      if (openingEntry === undefined) {
        return;
      }

      const opening = WagerTransaction.createOpening({
        id: openingTransactionId,
        walletId,
        playerId: wallet.playerId,
        money: command.initialBalance,
        payloadHash: payloadHash({
          kind: WagerTransactionKind.Opening,
          walletId,
          playerId: wallet.playerId,
          money: { ...command.initialBalance.toJSON() },
        }),
        at,
      });
      await wagerTransactions.insert(opening);
      await ledger.insert(openingEntry);

      const context = (eventId: string) => ({ eventId, correlationId: command.correlationId, occurredAt: at });
      await outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet.balance, context(ids.next()))));
      await outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context(ids.next()))));
    });

    return wallet;
  }
}
