import { MetricsRegistry } from './metrics-registry';
import type { AppLogger } from './structured-logger';

/** Pendências lidas do banco a cada coleta: iguais em todas as instâncias. */
export interface Backlog {
  outboxPending: number;
  /** Idade, em segundos, do evento mais antigo ainda não publicado (0 sem pendentes). */
  outboxOldestPendingAgeSeconds: number;
  pendingReferenceTransactions: number;
}

export interface WageringMetricsOptions {
  /** Leitura das pendências; sem ela, os gauges de backlog não são exportados. */
  readBacklog?: () => Promise<Backlog>;
  logger?: AppLogger;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LOCK_WAIT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** Catálogo das métricas da aplicação: os adaptadores registram nelas, e `render` exporta para o Prometheus. */
export class WageringMetrics {
  readonly registry = new MetricsRegistry();

  readonly transactions = this.registry.counter(
    'wagering_transactions_total',
    'Wager transaction outcomes recorded (new states, not replays).',
    ['kind', 'status', 'failure_code', 'origin'],
  );

  readonly idempotentReplays = this.registry.counter(
    'wagering_idempotent_replays_total',
    'Repeated submissions answered with the stored outcome.',
    ['kind', 'status'],
  );

  readonly submissionConflicts = this.registry.counter(
    'wagering_submission_conflicts_total',
    'Submissions refused because the idempotency key or the external transaction id was already used differently.',
    ['code'],
  );

  readonly lockConflicts = this.registry.counter(
    'wagering_lock_conflicts_total',
    'Database transactions aborted by lock or concurrency conflicts.',
    ['reason'],
  );

  readonly walletLockWait = this.registry.histogram(
    'wagering_wallet_lock_wait_seconds',
    'Time to acquire the wallet row lock (SELECT ... FOR UPDATE).',
    [],
    LOCK_WAIT_BUCKETS,
  );

  readonly messages = this.registry.counter(
    'wagering_messages_total',
    'Queue messages handled, by outcome (processed, duplicate, retried, dead_lettered).',
    ['outcome', 'failure_code'],
  );

  readonly messageDuration = this.registry.histogram(
    'wagering_message_processing_seconds',
    'Time to process a queue message, until the outcome is decided.',
    ['outcome'],
    LATENCY_BUCKETS,
  );

  readonly outboxPublished = this.registry.counter('wagering_outbox_published_total', 'Outbox events published.');

  readonly outboxPublishFailures = this.registry.counter(
    'wagering_outbox_publish_failures_total',
    'Outbox events not accepted by the broker and scheduled for retry.',
  );

  readonly reconciliations = this.registry.counter(
    'wagering_reconciliations_total',
    'Wallet reconciliations, by result (consistent, divergent).',
    ['result'],
  );

  readonly httpRequestDuration = this.registry.histogram(
    'http_request_duration_seconds',
    'HTTP request latency, by route template.',
    ['method', 'route', 'status_code'],
    LATENCY_BUCKETS,
  );

  private backlog: Promise<Backlog | undefined> | undefined;

  constructor(private readonly options: WageringMetricsOptions = {}) {
    if (options.readBacklog) {
      this.registry.gauge('wagering_outbox_pending_messages', 'Outbox events not yet published.', async () =>
        (await this.readBacklog())?.outboxPending,
      );
      this.registry.gauge(
        'wagering_outbox_oldest_pending_age_seconds',
        'Age of the oldest unpublished outbox event (outbox lag).',
        async () => (await this.readBacklog())?.outboxOldestPendingAgeSeconds,
      );
      this.registry.gauge(
        'wagering_pending_reference_transactions',
        'Transactions waiting for their reference (PENDING_REFERENCE).',
        async () => (await this.readBacklog())?.pendingReferenceTransactions,
      );
    }
  }

  /** Texto de exposição do Prometheus; o backlog é lido uma vez por coleta. */
  async render(): Promise<string> {
    try {
      return await this.registry.render();
    } finally {
      this.backlog = undefined;
    }
  }

  private readBacklog(): Promise<Backlog | undefined> {
    this.backlog ??= this.options.readBacklog!().catch((error: unknown) => {
      this.options.logger?.warn('Could not read the backlog for metrics', {
        reason: error instanceof Error ? error.message || error.name : String(error),
      });
      return undefined;
    });
    return this.backlog;
  }
}
