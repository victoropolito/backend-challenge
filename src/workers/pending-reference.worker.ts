import type { RecheckPendingReferencesUseCase } from '../application/wagering/recheck-pending-references.use-case';
import type { AppLogger } from '../infrastructure/observability/structured-logger';
import { PollingLoop } from './polling-loop';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  /** Espera quando não há mais transações vencidas (ou depois de um erro). */
  idleDelayMs: number;
}

export interface PendingReferenceWorkerDependencies {
  recheck: Pick<RecheckPendingReferencesUseCase, 'execute'>;
  logger: AppLogger;
  options: PendingReferenceWorkerOptions;
}

/**
 * Reverifica as transações PENDING_REFERENCE vencidas em lotes, continuamente: sem pausa enquanto houver lotes cheios,
 * e com `idleDelayMs` de espera quando não há mais vencidas. Várias instâncias podem rodar ao mesmo tempo (cada
 * transação é reverificada com a wallet travada). `stop` interrompe a espera e aguarda o lote em andamento.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop;

  constructor(deps: PendingReferenceWorkerDependencies) {
    const { recheck, logger, options } = deps;
    this.loop = new PollingLoop({
      idleDelayMs: options.idleDelayMs,
      tick: async () => {
        const result = await recheck.execute(options.batchSize);
        for (const [id, error] of result.errors) {
          logger.error('Pending reference recheck failed', { transactionId: id }, error);
        }
        return result.due === options.batchSize && result.errors.size === 0;
      },
      onError: (error) => logger.error('Pending reference batch failed', undefined, error),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
