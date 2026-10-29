import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';

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
  ],
  exports: [SQSClient],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
