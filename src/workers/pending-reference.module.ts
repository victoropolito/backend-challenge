import { Inject, Logger, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { ApplicationModule } from '../application/application.module';
import { RecheckPendingReferencesUseCase } from '../application/wagering/recheck-pending-references.use-case';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PendingReferenceWorker } from './pending-reference.worker';

/** Liga o worker de PENDING_REFERENCE ao ciclo de vida da aplicação (se habilitado na config). */
@Module({ imports: [ApplicationModule] })
export class PendingReferenceModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly worker: PendingReferenceWorker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecheckPendingReferencesUseCase) recheck: RecheckPendingReferencesUseCase,
  ) {
    this.worker = new PendingReferenceWorker({
      recheck,
      logger: new Logger('PendingReferenceWorker'),
      options: { batchSize: config.referenceWorker.batchSize, idleDelayMs: config.referenceWorker.idleDelayMs },
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.referenceWorker.enabled) {
      this.worker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
