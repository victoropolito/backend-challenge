import { Module, type Provider } from '@nestjs/common';
import { InboxRepository, OutboxRepository } from '../domain/messaging/messaging-repositories';
import { WagerTransactionRepository } from '../domain/wagering/wager-transaction-repository';
import { LedgerRepository, WalletRepository } from '../domain/wallet/wallet-repository';
import { SystemClock } from '../infrastructure/system/system-clock';
import { UuidV7Generator } from '../infrastructure/system/uuid-v7-generator';
import { EventPublisher } from './messaging/event-publisher';
import { PublishOutboxUseCase } from './messaging/publish-outbox.use-case';
import { Clock } from './shared/clock';
import { IdGenerator } from './shared/id-generator';
import { TransactionRunner } from './shared/transaction-runner';
import { ConsumeWagerTransactionMessageUseCase } from './wagering/consume-wager-transaction-message.use-case';
import { SubmitWagerTransactionUseCase } from './wagering/submit-wager-transaction.use-case';
import { WagerTransactionQueries } from './wagering/wager-transaction-queries';
import { WagerTransactionProcessor } from './wagering/wager-transaction-processor';
import { CreateWalletUseCase } from './wallet/create-wallet.use-case';
import { WalletQueries } from './wallet/wallet-queries';

/** Nome do consumidor da fila de transações na inbox. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

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
  {
    provide: SubmitWagerTransactionUseCase,
    inject: [
      TransactionRunner,
      WalletRepository,
      WagerTransactionRepository,
      WagerTransactionProcessor,
      InboxRepository,
      Clock,
      IdGenerator,
    ],
    useFactory: (
      transactions: TransactionRunner,
      wallets: WalletRepository,
      wagerTransactions: WagerTransactionRepository,
      processor: WagerTransactionProcessor,
      inbox: InboxRepository,
      clock: Clock,
      ids: IdGenerator,
    ) => new SubmitWagerTransactionUseCase({ transactions, wallets, wagerTransactions, processor, inbox, clock, ids }),
  },
  {
    provide: PublishOutboxUseCase,
    inject: [TransactionRunner, OutboxRepository, EventPublisher, Clock],
    useFactory: (transactions: TransactionRunner, outbox: OutboxRepository, publisher: EventPublisher, clock: Clock) =>
      new PublishOutboxUseCase({ transactions, outbox, publisher, clock }),
  },
  {
    provide: ConsumeWagerTransactionMessageUseCase,
    inject: [InboxRepository, SubmitWagerTransactionUseCase],
    useFactory: (inbox: InboxRepository, submit: SubmitWagerTransactionUseCase) =>
      new ConsumeWagerTransactionMessageUseCase({ consumerName: WAGER_TRANSACTIONS_CONSUMER, inbox, submit }),
  },
];

const QUERIES: Provider[] = [
  {
    provide: WalletQueries,
    inject: [WalletRepository, LedgerRepository],
    useFactory: (wallets: WalletRepository, ledger: LedgerRepository) => new WalletQueries({ wallets, ledger }),
  },
  {
    provide: WagerTransactionQueries,
    inject: [WagerTransactionRepository],
    useFactory: (wagerTransactions: WagerTransactionRepository) => new WagerTransactionQueries(wagerTransactions),
  },
];

const PROCESSOR: Provider = {
  provide: WagerTransactionProcessor,
  inject: [WalletRepository, LedgerRepository, WagerTransactionRepository, OutboxRepository, IdGenerator],
  useFactory: (
    wallets: WalletRepository,
    ledger: LedgerRepository,
    wagerTransactions: WagerTransactionRepository,
    outbox: OutboxRepository,
    ids: IdGenerator,
  ) => new WagerTransactionProcessor({ wallets, ledger, wagerTransactions, outbox, ids }),
};

/** Casos de uso e consultas da aplicação, com relógio e gerador de ids do sistema (o relógio é exportado para os adaptadores). */
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
    PROCESSOR,
    ...USE_CASES,
    ...QUERIES,
  ],
  exports: [Clock, PROCESSOR, ...USE_CASES, ...QUERIES],
})
export class ApplicationModule {}
