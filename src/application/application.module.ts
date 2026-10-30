import { Module, type Provider } from '@nestjs/common';
import { OutboxRepository } from '../domain/messaging/messaging-repositories';
import { WagerTransactionRepository } from '../domain/wagering/wager-transaction-repository';
import { LedgerRepository, WalletRepository } from '../domain/wallet/wallet-repository';
import { SystemClock } from '../infrastructure/system/system-clock';
import { UuidV7Generator } from '../infrastructure/system/uuid-v7-generator';
import { Clock } from './shared/clock';
import { IdGenerator } from './shared/id-generator';
import { TransactionRunner } from './shared/transaction-runner';
import { CreateWalletUseCase } from './wallet/create-wallet.use-case';

const USE_CASES: Provider[] = [
  {
    provide: CreateWalletUseCase,
    inject: [TransactionRunner, WalletRepository, LedgerRepository, WagerTransactionRepository, OutboxRepository, Clock, IdGenerator],
    useFactory: (
      transactions: TransactionRunner,
      wallets: WalletRepository,
      ledger: LedgerRepository,
      wagerTransactions: WagerTransactionRepository,
      outbox: OutboxRepository,
      clock: Clock,
      ids: IdGenerator,
    ) => new CreateWalletUseCase({ transactions, wallets, ledger, wagerTransactions, outbox, clock, ids }),
  },
];

/** Casos de uso da aplicação, com relógio e gerador de ids do sistema. */
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    ...USE_CASES,
  ],
  exports: USE_CASES,
})
export class ApplicationModule {}
