import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthModule } from './health/health.module';
import { ApiModule } from './http/api.module';
import { ConsumerModule } from './consumer/consumer.module';
import { OutboxPublisherModule } from './workers/outbox-publisher.module';
import { PendingReferenceModule } from './workers/pending-reference.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    SqsModule,
    ApiModule,
    ConsumerModule,
    OutboxPublisherModule,
    PendingReferenceModule,
    HealthModule,
  ],
})
export class AppModule {}
