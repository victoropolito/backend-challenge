import { Inject, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { PublishOutboxUseCase } from '../application/messaging/publish-outbox.use-case';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { StructuredLogger } from '../infrastructure/observability/structured-logger';
import { WageringMetrics } from '../infrastructure/observability/wagering-metrics';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

/** Liga o publisher da outbox ao ciclo de vida da aplicação (se habilitado na config). */
@Module({ imports: [ApplicationModule] })
export class OutboxPublisherModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly worker: OutboxPublisherWorker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutboxUseCase) publish: PublishOutboxUseCase,
    @Inject(WageringMetrics) metrics: WageringMetrics,
  ) {
    this.worker = new OutboxPublisherWorker({
      publish,
      logger: new StructuredLogger('OutboxPublisher'),
      metrics,
      options: { batchSize: config.outbox.batchSize, idleDelayMs: config.outbox.idleDelayMs },
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.outbox.enabled) {
      this.worker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
