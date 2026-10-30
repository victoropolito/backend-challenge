import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { MetricsController } from './metrics.controller';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

/** Endpoints HTTP da API de wallets e transações, e o endpoint de métricas. */
@Module({
  imports: [ApplicationModule],
  controllers: [WalletsController, WageringController, MetricsController],
})
export class ApiModule {}
