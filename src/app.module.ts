import { Module } from '@nestjs/common';
import { ApplicationModule } from './application/application.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule, ApplicationModule, HealthModule],
})
export class AppModule {}
