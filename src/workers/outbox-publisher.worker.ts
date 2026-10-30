import type { PublishOutboxUseCase } from '../application/messaging/publish-outbox.use-case';
import type { AppLogger } from '../infrastructure/observability/structured-logger';
import { PollingLoop } from './polling-loop';

export interface OutboxPublisherWorkerOptions {
  batchSize: number;
  /** Espera quando a outbox não tem mais mensagens vencidas (ou depois de um erro). */
  idleDelayMs: number;
}

export interface OutboxPublisherWorkerDependencies {
  publish: Pick<PublishOutboxUseCase, 'execute'>;
  logger: AppLogger;
  options: OutboxPublisherWorkerOptions;
}

/**
 * Publica a outbox em lotes, continuamente: sem pausa enquanto houver lotes cheios, e com `idleDelayMs` de espera
 * quando a outbox esvazia. Várias instâncias podem rodar ao mesmo tempo (cada lote trava as próprias mensagens).
 * `stop` interrompe a espera e aguarda o lote em andamento.
 */
export class OutboxPublisherWorker {
  private readonly loop: PollingLoop;

  constructor(deps: OutboxPublisherWorkerDependencies) {
    const { publish, logger, options } = deps;
    this.loop = new PollingLoop({
      idleDelayMs: options.idleDelayMs,
      tick: async () => {
        const result = await publish.execute(options.batchSize);
        for (const [id, reason] of result.failures) {
          logger.warn('Event not published, will retry', { eventId: id, reason });
        }
        return result.claimed === options.batchSize && result.failures.size === 0;
      },
      onError: (error) => logger.error('Outbox batch failed', undefined, error),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
