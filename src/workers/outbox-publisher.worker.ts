import type { PublishOutboxUseCase } from '../application/messaging/publish-outbox.use-case';
import { describeError, PollingLoop, type WorkerLogger } from './polling-loop';

export type { WorkerLogger } from './polling-loop';

export interface OutboxPublisherWorkerOptions {
  batchSize: number;
  /** Espera quando a outbox não tem mais mensagens vencidas (ou depois de um erro). */
  idleDelayMs: number;
}

export interface OutboxPublisherWorkerDependencies {
  publish: Pick<PublishOutboxUseCase, 'execute'>;
  logger: WorkerLogger;
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
          logger.warn(`Event ${id} not published, will retry: ${reason}`);
        }
        return result.claimed === options.batchSize && result.failures.size === 0;
      },
      onError: (error) =>
        logger.error(`Outbox batch failed: ${describeError(error)}`, error instanceof Error ? error.stack : undefined),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
