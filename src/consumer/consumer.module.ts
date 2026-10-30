import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ApplicationModule } from '../application/application.module';
import { Clock } from '../application/shared/clock';
import { ConsumeWagerTransactionMessageUseCase } from '../application/wagering/consume-wager-transaction-message.use-case';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import { SqsWagerTransactionConsumer } from './sqs-wager-transaction-consumer';

const QUEUE_LOOKUP_RETRY_MS = 2_000;

/** Liga o consumidor da fila de transações ao ciclo de vida da aplicação (se habilitado na config). */
@Module({ imports: [ApplicationModule] })
export class ConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new StructuredLogger('WagerTransactionConsumer');
  private consumer: SqsWagerTransactionConsumer | undefined;
  private starting: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(ConsumeWagerTransactionMessageUseCase) private readonly handler: ConsumeWagerTransactionMessageUseCase,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) {
      this.starting = this.startWhenQueuesExist();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.starting;
    await this.consumer?.stop();
  }

  /** As filas podem ainda não estar acessíveis no boot; tenta de novo até conseguir ou a aplicação parar. */
  private async startWhenQueuesExist(): Promise<void> {
    const { sqs: queues, consumer: options } = this.config;
    while (!this.shuttingDown) {
      try {
        const [queueUrl, deadLetterQueueUrl] = await Promise.all(
          [queues.wagerQueueName, queues.wagerDlqName].map(async (QueueName) => {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName }));
            return QueueUrl!;
          }),
        );
        this.consumer = new SqsWagerTransactionConsumer({
          sqs: this.sqs,
          handler: this.handler,
          clock: this.clock,
          logger: this.logger,
          options: { ...options, queueUrl: queueUrl!, deadLetterQueueUrl: deadLetterQueueUrl! },
        });
        this.consumer.start();
        this.logger.info('Consuming', { queue: queues.wagerQueueName, deadLetterQueue: queues.wagerDlqName });
        return;
      } catch (error) {
        this.logger.warn('Queues not available yet', { reason: (error as Error).message || (error as Error).name });
        await Bun.sleep(QUEUE_LOOKUP_RETRY_MS);
      }
    }
  }
}
