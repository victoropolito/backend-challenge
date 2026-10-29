import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { buildMikroOrmConfig } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildMikroOrmConfig(config),
      driver: PostgreSqlDriver,
    }),
  ],
})
export class DatabaseModule {}
