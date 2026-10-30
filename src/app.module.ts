import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthModule } from './health/health.module';
import { ApiModule } from './http/api.module';
import { ConsumerModule } from './consumer/consumer.module';

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule, ApiModule, ConsumerModule, HealthModule],
})
export class AppModule {}
