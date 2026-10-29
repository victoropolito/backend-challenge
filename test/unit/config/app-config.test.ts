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
});
