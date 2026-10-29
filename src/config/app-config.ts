import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  SQS_WAGER_QUEUE_NAME: z.string().endsWith('.fifo').default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().endsWith('.fifo').default('wager-transactions-dlq.fifo'),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
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
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    aws: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      credentials: hasCredentials
        ? { accessKeyId: e.AWS_ACCESS_KEY_ID!, secretAccessKey: e.AWS_SECRET_ACCESS_KEY! }
        : undefined,
    },
    sqs: { wagerQueueName: e.SQS_WAGER_QUEUE_NAME, wagerDlqName: e.SQS_WAGER_DLQ_NAME },
  };
}
