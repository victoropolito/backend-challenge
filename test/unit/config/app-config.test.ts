import { describe, expect, it } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../../src/config/app-config';

const validEnv = {
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
};

describe('loadConfig', () => {
  it('applies defaults when only required variables are present', () => {
    const config = loadConfig(validEnv);

    expect(config.port).toBe(3000);
    expect(config.sqs.wagerQueueName).toBe('wager-transactions.fifo');
    expect(config.sqs.wagerDlqName).toBe('wager-transactions-dlq.fifo');
    expect(config.sqs.eventsQueueName).toBe('wagering-events.fifo');
    expect(config.outbox).toEqual({ enabled: true, batchSize: 10, idleDelayMs: 500, publishTimeoutMs: 5_000 });
    expect(config.aws.credentials).toBeUndefined();
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(InvalidConfigError);
  });

  it('rejects non-FIFO queue names', () => {
    expect(() => loadConfig({ ...validEnv, SQS_WAGER_QUEUE_NAME: 'wager-transactions' })).toThrow(
      InvalidConfigError,
    );
  });

  it('only builds credentials when both key and secret are given', () => {
    expect(loadConfig({ ...validEnv, AWS_ACCESS_KEY_ID: 'test' }).aws.credentials).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' }).aws.credentials,
    ).toEqual({ accessKeyId: 'test', secretAccessKey: 'test' });
  });

  it('applies the consumer defaults', () => {
    expect(loadConfig(validEnv).consumer).toEqual({
      enabled: true,
      waitTimeSeconds: 10,
      batchSize: 10,
      visibilityTimeoutSeconds: 30,
      maxAttempts: 5,
      retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
      shutdownTimeoutMs: 20_000,
    });
  });

  it('reads the consumer switch and limits', () => {
    expect(loadConfig({ ...validEnv, SQS_CONSUMER_ENABLED: 'false' }).consumer.enabled).toBe(false);
    expect(() => loadConfig({ ...validEnv, SQS_CONSUMER_ENABLED: 'maybe' })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...validEnv, SQS_CONSUMER_BATCH_SIZE: '11' })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: '21' })).toThrow(InvalidConfigError);
    expect(loadConfig({ ...validEnv, OUTBOX_PUBLISHER_ENABLED: 'false' }).outbox.enabled).toBe(false);
    expect(() => loadConfig({ ...validEnv, OUTBOX_BATCH_SIZE: '0' })).toThrow(InvalidConfigError);
  });
});
