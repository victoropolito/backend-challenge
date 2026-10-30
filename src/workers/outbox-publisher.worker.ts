import type { PublishOutboxUseCase } from '../application/messaging/publish-outbox.use-case';

export interface WorkerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, stack?: string): void;
}

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
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: OutboxPublisherWorkerDependencies) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { publish, logger, options } = this.deps;
    while (this.running) {
      try {
        const result = await publish.execute(options.batchSize);
        for (const [id, reason] of result.failures) {
          logger.warn(`Event ${id} not published, will retry: ${reason}`);
        }
        if (result.claimed < options.batchSize || result.failures.size > 0) {
          await this.pause(options.idleDelayMs);
        }
      } catch (error) {
        logger.error(
          `Outbox batch failed: ${error instanceof Error ? error.message || error.name : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        await this.pause(options.idleDelayMs);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
