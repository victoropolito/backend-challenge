import { Global, Module, type Provider } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { TransactionRunner } from '../../application/shared/transaction-runner';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { InboxRepository, OutboxRepository } from '../../domain/messaging/messaging-repositories';
import { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import { LedgerRepository, WalletRepository } from '../../domain/wallet/wallet-repository';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { MikroOrmTransactionRunner } from './mikro-orm-transaction-runner';
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from './repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmLedgerRepository, MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

const withEntityManager = <T>(token: abstract new (...args: never[]) => T, create: (em: EntityManager) => T): Provider => ({
  provide: token,
  inject: [EntityManager],
  useFactory: create,
});

const PROVIDERS: Provider[] = [
  withEntityManager(TransactionRunner, (em) => new MikroOrmTransactionRunner(em)),
  withEntityManager(WalletRepository, (em) => new MikroOrmWalletRepository(em)),
  withEntityManager(LedgerRepository, (em) => new MikroOrmLedgerRepository(em)),
  withEntityManager(WagerTransactionRepository, (em) => new MikroOrmWagerTransactionRepository(em)),
  withEntityManager(InboxRepository, (em) => new MikroOrmInboxRepository(em)),
  withEntityManager(OutboxRepository, (em) => new MikroOrmOutboxRepository(em)),
];

/** Conexão com o PostgreSQL via MikroORM, implementações dos repositórios do domínio e o TransactionRunner. */
@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildMikroOrmConfig(config),
      driver: PostgreSqlDriver,
    }),
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class DatabaseModule {}
