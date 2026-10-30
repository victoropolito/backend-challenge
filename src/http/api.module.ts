import { Module } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

/** Endpoints HTTP da API de wallets e transações. */
@Module({
  imports: [ApplicationModule],
  controllers: [WalletsController, WageringController],
})
export class ApiModule {}
