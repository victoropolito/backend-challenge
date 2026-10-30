import { Global, Module, type Provider } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { InboxRepository, OutboxRepository } from '../../domain/messaging/messaging-repositories';
import { WagerTransactionRepository } from '../../domain/wagering/wager-transaction-repository';
import { LedgerRepository, WalletRepository } from '../../domain/wallet/wallet-repository';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { MikroOrmInboxRepository, MikroOrmOutboxRepository } from './repositories/mikro-orm-messaging.repositories';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmLedgerRepository, MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

const repository = <T>(token: abstract new (...args: never[]) => T, create: (em: EntityManager) => T): Provider => ({
  provide: token,
  inject: [EntityManager],
  useFactory: create,
});

const REPOSITORIES: Provider[] = [
  repository(WalletRepository, (em) => new MikroOrmWalletRepository(em)),
  repository(LedgerRepository, (em) => new MikroOrmLedgerRepository(em)),
  repository(WagerTransactionRepository, (em) => new MikroOrmWagerTransactionRepository(em)),
  repository(InboxRepository, (em) => new MikroOrmInboxRepository(em)),
  repository(OutboxRepository, (em) => new MikroOrmOutboxRepository(em)),
];

/** Conexão com o PostgreSQL via MikroORM e implementações dos repositórios do domínio. */
@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildMikroOrmConfig(config),
      driver: PostgreSqlDriver,
    }),
  ],
  providers: REPOSITORIES,
  exports: REPOSITORIES,
})
export class DatabaseModule {}
