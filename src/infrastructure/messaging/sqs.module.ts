import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/messaging/event-publisher';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { SqsEventPublisher } from './sqs-event-publisher';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.aws.region,
          ...(config.aws.endpoint !== undefined && { endpoint: config.aws.endpoint }),
          ...(config.aws.credentials !== undefined && { credentials: config.aws.credentials }),
        }),
    },
    {
      provide: EventPublisher,
      inject: [SQSClient, APP_CONFIG],
      useFactory: (sqs: SQSClient, config: AppConfig) =>
        new SqsEventPublisher(sqs, {
          queueName: config.sqs.eventsQueueName,
          timeoutMs: config.outbox.publishTimeoutMs,
        }),
    },
  ],
  exports: [SQSClient, EventPublisher],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
