import { z } from 'zod';
import { LOG_LEVELS, type LogLevelName } from '../infrastructure/observability/structured-logger';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().endsWith('.fifo').default('wagering-events.fifo'),

  SQS_CONSUMER_ENABLED: z.stringbool().default(true),
  SQS_CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(43_200).default(30),
  SQS_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  SQS_CONSUMER_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1_000),
  SQS_CONSUMER_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(43_200_000).default(60_000),
  SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(20_000),

  OUTBOX_PUBLISHER_ENABLED: z.stringbool().default(true),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  OUTBOX_IDLE_DELAY_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

  REFERENCE_WORKER_ENABLED: z.stringbool().default(true),
  REFERENCE_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  REFERENCE_WORKER_IDLE_DELAY_MS: z.coerce.number().int().min(10).default(1_000),
  REFERENCE_CHECK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(15),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: LogLevelName;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined;
  };
  readonly sqs: {
    readonly wagerQueueName: string;
    readonly wagerDlqName: string;
    readonly eventsQueueName: string;
  };
  readonly consumer: {
    readonly enabled: boolean;
    readonly waitTimeSeconds: number;
    readonly batchSize: number;
    readonly visibilityTimeoutSeconds: number;
    readonly maxAttempts: number;
    readonly retryPolicy: { readonly baseDelayMs: number; readonly maxDelayMs: number };
    readonly shutdownTimeoutMs: number;
  };
  readonly outbox: {
    readonly enabled: boolean;
    readonly batchSize: number;
    readonly idleDelayMs: number;
    readonly publishTimeoutMs: number;
  };
  readonly referenceWorker: {
    readonly enabled: boolean;
    readonly batchSize: number;
    readonly idleDelayMs: number;
    readonly maxAttempts: number;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class InvalidConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvalidConfigError';
  }
}

/** Lê e valida o ambiente uma única vez; falha rápido no boot se algo estiver errado. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new InvalidConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const e = parsed.data;
  const hasCredentials = e.AWS_ACCESS_KEY_ID !== undefined && e.AWS_SECRET_ACCESS_KEY !== undefined;

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    aws: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      credentials: hasCredentials
        ? { accessKeyId: e.AWS_ACCESS_KEY_ID!, secretAccessKey: e.AWS_SECRET_ACCESS_KEY! }
        : undefined,
    },
    sqs: {
      wagerQueueName: e.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: e.SQS_WAGER_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
    },
    consumer: {
      enabled: e.SQS_CONSUMER_ENABLED,
      waitTimeSeconds: e.SQS_CONSUMER_WAIT_TIME_SECONDS,
      batchSize: e.SQS_CONSUMER_BATCH_SIZE,
      visibilityTimeoutSeconds: e.SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS,
      maxAttempts: e.SQS_CONSUMER_MAX_ATTEMPTS,
      retryPolicy: { baseDelayMs: e.SQS_CONSUMER_RETRY_BASE_DELAY_MS, maxDelayMs: e.SQS_CONSUMER_RETRY_MAX_DELAY_MS },
      shutdownTimeoutMs: e.SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS,
    },
    outbox: {
      enabled: e.OUTBOX_PUBLISHER_ENABLED,
      batchSize: e.OUTBOX_BATCH_SIZE,
      idleDelayMs: e.OUTBOX_IDLE_DELAY_MS,
      publishTimeoutMs: e.OUTBOX_PUBLISH_TIMEOUT_MS,
    },
    referenceWorker: {
      enabled: e.REFERENCE_WORKER_ENABLED,
      batchSize: e.REFERENCE_WORKER_BATCH_SIZE,
      idleDelayMs: e.REFERENCE_WORKER_IDLE_DELAY_MS,
      maxAttempts: e.REFERENCE_CHECK_MAX_ATTEMPTS,
    },
  };
}
